import {
  createId,
  nowIso,
  type CheckResult,
  type CriteriaResult,
  type Evaluation,
  type Finding,
  type Hypothesis,
  type IterationPolicy,
  type ProgressLedger,
  type TaskEvidence
} from "@flint/core-types";

interface DeterministicCheckLike {
  type: string;
  pass: boolean;
  detail: string;
}

export type IterationDecision =
  | { action: "complete"; reason: string }
  | { action: "continue"; reason: string; nextHypothesis?: Hypothesis }
  | { action: "review_required"; reason: string }
  | { action: "failed"; reason: string };

export const defaultIterationPolicy: IterationPolicy = {
  maxAttempts: 3,
  maxToolIterationsPerStep: 3,
  maxTotalToolCalls: 48,
  stagnationWindow: 2,
  minProgressDelta: 0.05,
  allowBranching: false,
  requireHumanReviewOnRisk: true
};

export function normalizeIterationPolicy(policy?: Partial<IterationPolicy>): IterationPolicy {
  return {
    ...defaultIterationPolicy,
    ...policy,
    maxAttempts: Math.max(1, policy?.maxAttempts ?? defaultIterationPolicy.maxAttempts),
    maxToolIterationsPerStep: Math.max(1, policy?.maxToolIterationsPerStep ?? defaultIterationPolicy.maxToolIterationsPerStep),
    maxTotalToolCalls: Math.max(1, policy?.maxTotalToolCalls ?? defaultIterationPolicy.maxTotalToolCalls),
    stagnationWindow: Math.max(1, policy?.stagnationWindow ?? defaultIterationPolicy.stagnationWindow),
    minProgressDelta: Math.max(0, policy?.minProgressDelta ?? defaultIterationPolicy.minProgressDelta)
  };
}

export function createProgressLedger(): ProgressLedger {
  return {
    score: 0,
    scoreHistory: [],
    passedChecks: [],
    failedChecks: [],
    fixedFindings: [],
    openFindings: [],
    blockers: [],
    currentHypotheses: [],
    stagnationCount: 0,
    totalToolCalls: 0,
    attempts: 0,
    updatedAt: nowIso()
  };
}

export function updateProgressLedger(
  previous: ProgressLedger | undefined,
  evaluation: Evaluation,
  options: {
    deterministicChecks?: DeterministicCheckLike[];
    criteriaResults?: CriteriaResult[];
    evidence?: TaskEvidence[];
    policy?: IterationPolicy;
    attempts?: number;
  } = {}
): ProgressLedger {
  const base = previous ?? createProgressLedger();
  const policy = options.policy ?? defaultIterationPolicy;
  const checkResults = [
    ...checksFromDeterministic(options.deterministicChecks ?? evaluation.deterministicChecks ?? []),
    ...checksFromCriteria(options.criteriaResults ?? evaluation.criteriaResults ?? [])
  ];
  const passedChecks = [...base.passedChecks, ...checkResults.filter((check) => check.status === "pass")];
  const failedChecks = mergeChecks(base.failedChecks, checkResults.filter((check) => check.status !== "pass"));
  const openFindings = mergeFindings([
    ...base.openFindings,
    ...evaluation.findings.map((finding, index): Finding => ({
      id: createId("finding"),
      summary: finding,
      source: "judge",
      severity: evaluation.verdict === "fail" ? "blocking" : "error",
      evidenceRefs: evaluation.evidenceRefs
    })),
    ...failedChecks.map((check): Finding => ({
      id: createId("finding"),
      summary: check.summary,
      source: check.name.startsWith("criteria:") ? "criteria" : "deterministic",
      severity: check.status === "fail" ? "error" : "warning",
      evidenceRefs: check.evidenceRefs
    }))
  ]);
  const fixedFindings = base.openFindings.filter((finding) =>
    checkResults.some((check) => check.status === "pass" && check.summary === finding.summary)
  );
  const score = computeProgressScore(evaluation, checkResults);
  const previousScore = base.scoreHistory.at(-1) ?? base.score;
  const delta = score - previousScore;
  const stagnationCount = delta < policy.minProgressDelta ? base.stagnationCount + 1 : 0;
  const blockers = [
    ...base.blockers,
    ...failedChecks
      .filter((check) => check.status === "fail" && /permission|tool_failure|tests/u.test(check.name))
      .map((check) => ({
        id: createId("blocker"),
        summary: check.summary,
        source: check.name.includes("permission") ? ("policy" as const) : ("tool" as const),
        recoverable: true,
        evidenceRefs: check.evidenceRefs
      }))
  ];

  return {
    score,
    scoreHistory: [...base.scoreHistory, score],
    passedChecks,
    failedChecks,
    fixedFindings,
    openFindings,
    blockers,
    currentHypotheses: generateHypotheses(evaluation, failedChecks),
    stagnationCount,
    totalToolCalls: base.totalToolCalls + (options.evidence?.filter((item) => item.stepId && item.toolName !== "judge").length ?? 0),
    attempts: options.attempts ?? base.attempts,
    updatedAt: nowIso()
  };
}

export function decideNextIteration(
  policy: IterationPolicy,
  ledger: ProgressLedger,
  evaluation: Evaluation,
  attempts: number
): IterationDecision {
  if (evaluation.overallVerdict === "pass" || evaluation.verdict === "pass") {
    return { action: "complete", reason: "Canonical verdict passed." };
  }
  if (evaluation.verdict === "fail" && !policy.allowBranching && attempts >= 1) {
    return { action: "review_required", reason: "Failure needs human review because branching is disabled." };
  }
  if (attempts >= policy.maxAttempts) {
    return { action: "review_required", reason: `Iteration policy reached maxAttempts=${policy.maxAttempts}.` };
  }
  if (ledger.totalToolCalls >= policy.maxTotalToolCalls) {
    return { action: "review_required", reason: `Iteration policy reached maxTotalToolCalls=${policy.maxTotalToolCalls}.` };
  }
  if (ledger.stagnationCount >= policy.stagnationWindow) {
    return { action: "review_required", reason: "Progress stagnated across the configured window." };
  }
  const nextHypothesis = ledger.currentHypotheses[0];
  return {
    action: "continue",
    reason: nextHypothesis ? `Continue with hypothesis: ${nextHypothesis.summary}` : "Continue with evaluation repair steps.",
    nextHypothesis
  };
}

function checksFromDeterministic(checks: DeterministicCheckLike[]): CheckResult[] {
  return checks.map((check) => ({
    id: createId("check"),
    name: `deterministic:${check.type}`,
    status: check.pass ? "pass" : "fail",
    summary: check.detail,
    evidenceRefs: [],
    weight: check.type === "tests" ? 2 : 1
  }));
}

function checksFromCriteria(criteria: CriteriaResult[]): CheckResult[] {
  return criteria.map((item) => ({
    id: createId("check"),
    name: `criteria:${item.criteriaId}`,
    status: item.status,
    summary: item.rationale || item.statement,
    evidenceRefs: item.evidenceRefs,
    weight: 2
  }));
}

function computeProgressScore(evaluation: Evaluation, checks: CheckResult[]): number {
  const scores = evaluation.scores;
  const judgeScore = (scores.completion + scores.correctness + scores.scopeControl + scores.safety + scores.quality + scores.communication) / 6;
  const checkWeight = checks.reduce((sum, check) => sum + (check.weight ?? 1), 0);
  const passedWeight = checks.reduce((sum, check) => sum + (check.status === "pass" ? check.weight ?? 1 : 0), 0);
  const checkScore = checkWeight ? passedWeight / checkWeight : 0.5;
  const verdictBoost = evaluation.overallVerdict === "pass" || evaluation.verdict === "pass" ? 0.1 : 0;
  return Math.max(0, Math.min(1, judgeScore * 0.55 + checkScore * 0.35 + verdictBoost));
}

function mergeChecks(existing: CheckResult[], incoming: CheckResult[]): CheckResult[] {
  const byName = new Map<string, CheckResult>();
  for (const check of [...existing, ...incoming]) {
    byName.set(`${check.name}:${check.summary}`, check);
  }
  return Array.from(byName.values());
}

function mergeFindings(findings: Finding[]): Finding[] {
  const bySummary = new Map<string, Finding>();
  for (const finding of findings) {
    bySummary.set(finding.summary, finding);
  }
  return Array.from(bySummary.values());
}

function generateHypotheses(evaluation: Evaluation, failedChecks: CheckResult[]): Hypothesis[] {
  const fromChecks = failedChecks.slice(0, 3).map((check) => ({
    id: createId("hyp"),
    summary: `Resolve ${check.name}: ${check.summary}`,
    confidence: 0.75,
    nextStep: check.summary
  }));
  if (fromChecks.length) {
    return fromChecks;
  }
  return evaluation.suggestedNextSteps?.slice(0, 3).map((step) => ({
    id: createId("hyp"),
    summary: step.title,
    confidence: 0.6,
    nextStep: step.detail
  })) ?? [];
}
