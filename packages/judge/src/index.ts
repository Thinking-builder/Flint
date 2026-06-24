import {
  createId,
  nowIso,
  type Evaluation,
  type AcceptanceCriteria,
  type CriteriaResult,
  type JudgeResult,
  type JudgeVerdict,
  type Task,
  type TaskEvidence
} from "@flint/core-types";

export interface JudgeInput {
  task: Task;
  runSummary: string;
  diffSummary?: string;
  testResults?: string;
  policyEvents?: string;
  rawJudgeOutput?: string;
  evidence?: TaskEvidence[];
}

export function parseJudgeOutput(taskId: string, raw: string): Evaluation {
  try {
    const result = parseJudgeResult(raw);
    return evaluationFromJudgeResult(taskId, result);
  } catch {
    const partial = extractVerdictFromText(raw);
    if (partial.verdict && isVerdict(partial.verdict)) {
      return {
        id: createId("eval"),
        taskId,
        verdict: partial.verdict,
        confidence: typeof partial.confidence === "number" ? partial.confidence : 0.5,
        scores: {
          completion: 0.5,
          correctness: 0.5,
          scopeControl: 0.5,
          safety: 0.5,
          quality: 0.5,
          communication: 0.5
        },
        findings: ["Verdict extracted from plain text; structured JSON parsing failed."],
        evidenceRefs: ["judge_text_fallback"],
        createdAt: nowIso(),
        rationale: "Verdict was extracted from unstructured text because the judge did not return valid JSON."
      };
    }
    return reviewRequired(taskId, ["Judge output could not be parsed as valid JSON."]);
  }
}

export function parseJudgeResult(raw: string): JudgeResult {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText) as Partial<JudgeResult>;
  if (!isVerdict(parsed.verdict) || typeof parsed.confidence !== "number") {
    throw new Error("Invalid judge schema");
  }
  const suggestedNextSteps: Array<{ title: string; detail?: string }> = [];
  if (Array.isArray(parsed.suggestedNextSteps)) {
    for (const step of parsed.suggestedNextSteps) {
      const item = step as { title?: unknown; detail?: unknown };
      if (typeof item.title === "string" && item.title.trim()) {
        suggestedNextSteps.push({
          title: item.title.trim(),
          detail: typeof item.detail === "string" ? item.detail.trim() : undefined
        });
      }
      if (suggestedNextSteps.length >= 4) {
        break;
      }
    }
  }
  const criteriaResults = parseCriteriaResults(parsed.criteriaResults);
  const missingEvidence = Array.isArray(parsed.missingEvidence) ? parsed.missingEvidence.map(String) : undefined;
  const judgeRationale = typeof parsed.judgeRationale === "string" ? parsed.judgeRationale : undefined;

  return {
    verdict: parsed.verdict,
    confidence: clamp(parsed.confidence),
    scores: {
      completion: clamp(parsed.scores?.completion),
      correctness: clamp(parsed.scores?.correctness),
      scopeControl: clamp(parsed.scores?.scopeControl),
      safety: clamp(parsed.scores?.safety),
      quality: clamp(parsed.scores?.quality),
      communication: clamp(parsed.scores?.communication)
    },
    findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
    evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs.map(String) : [],
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
    suggestedNextSteps: suggestedNextSteps.length > 0 ? suggestedNextSteps : undefined,
    criteriaResults,
    missingEvidence,
    judgeRationale,
    rawOutput: raw
  };
}

export function evaluationFromJudgeResult(taskId: string, result: JudgeResult, revision = 1): Evaluation {
  return {
    id: createId("eval"),
    taskId,
    verdict: result.verdict,
    confidence: result.confidence,
    scores: result.scores,
    findings: result.findings,
    evidenceRefs: result.evidenceRefs,
    createdAt: nowIso(),
    rationale: result.rationale,
    suggestedNextSteps: result.suggestedNextSteps,
    revision,
    criteriaResults: result.criteriaResults,
    overallVerdict: result.verdict,
    missingEvidence: result.missingEvidence,
    nextSteps: result.suggestedNextSteps,
    judgeRationale: result.judgeRationale ?? result.rationale
  };
}

export function deriveAcceptanceCriteria(task: Task): AcceptanceCriteria[] {
  const prompt = task.prompt.replace(/\[\[[^\]]+\]\]/g, "").trim();
  const parts = prompt
    .split(/(?:\n+|[.;]|，|。)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);
  const criteria = parts.length ? parts : [task.title || "Complete the requested task"];
  return criteria.map((statement, index) => ({
    id: `ac_${index + 1}`,
    statement: normalizeCriterion(statement),
    whyItMatters: "This criterion is derived from the user's task prompt and defines task success.",
    verificationMethod: inferVerificationMethod(statement),
    requiredEvidence: inferRequiredEvidence(statement)
  }));
}

export function runHeuristicJudge(input: JudgeInput): Evaluation {
  if (input.rawJudgeOutput) {
    return parseJudgeOutput(input.task.id, input.rawJudgeOutput);
  }

  const text = `${input.runSummary}\n${input.testResults ?? ""}\n${input.policyEvents ?? ""}`.toLowerCase();
  const findings: string[] = [];

  // Safety check (highest priority)
  if (text.includes("secret") || text.includes("dangerous command") || text.includes("permission denied")) {
    return fail(input.task.id, ["Potential safety or policy issue detected."]);
  }

  // Evidence-based assessment (when evidence is available)
  if (input.evidence?.length) {
    const deterministicResult = runDeterministicChecks(input.task, input.evidence);
    const evidenceRefs = input.evidence.map((item) => item.id);

    // Successful writes + successful tests = high-confidence pass
    const hasSuccessfulWrites = input.evidence.some(
      (item) => (item.toolName === "writeFile" || item.toolName === "applyPatch") && item.status === "succeeded"
    );
    const hasSuccessfulTests = input.evidence.some((item) => item.toolName === "runTests" && isSuccessfulOutcome(item));
    const latestTest = input.evidence.filter((item) => item.toolName === "runTests").at(-1);
    const hasFailedTests = latestTest ? !isSuccessfulOutcome(latestTest) : false;

    if (hasFailedTests) {
      findings.push("Test execution failed.");
      return {
        ...reviewRequired(input.task.id, findings),
        evidenceRefs,
        deterministicChecks: deterministicResult.checks,
        rationale: "Tests failed during execution."
      };
    }

    if (deterministicResult.checks.some((check) => check.type === "permission_denied" && !check.pass)) {
      findings.push("Required permissions were denied.");
      return {
        ...reviewRequired(input.task.id, findings),
        evidenceRefs,
        deterministicChecks: deterministicResult.checks,
        rationale: "Some required tool permissions were denied."
      };
    }

    if (deterministicResult.checks.some((check) => check.type === "tool_failure" && !check.pass)) {
      // Tool failures without subsequent fixes
      const failedAfterFix = input.evidence.some((item) => isBlockingEvidence(item));
      if (failedAfterFix) {
        findings.push("Tool execution failed without recovery.");
        return {
          ...reviewRequired(input.task.id, findings),
          evidenceRefs,
          deterministicChecks: deterministicResult.checks,
          rationale: "Tool failures were not resolved."
        };
      }
    }

    if (hasSuccessfulWrites && hasSuccessfulTests) {
      return {
        id: createId("eval"),
        taskId: input.task.id,
        verdict: "pass",
        confidence: 0.92,
        scores: { completion: 0.95, correctness: 0.92, scopeControl: 0.9, safety: 0.92, quality: 0.88, communication: 0.86 },
        findings: [],
        evidenceRefs,
        createdAt: nowIso(),
        rationale: "File changes were made and tests passed successfully.",
        revision: input.task.result?.revision,
        deterministicChecks: deterministicResult.checks
      };
    }

    if (hasSuccessfulWrites && !hasFailedTests) {
      return {
        id: createId("eval"),
        taskId: input.task.id,
        verdict: "pass",
        confidence: 0.85,
        scores: { completion: 0.88, correctness: 0.82, scopeControl: 0.9, safety: 0.92, quality: 0.82, communication: 0.86 },
        findings: [],
        evidenceRefs,
        createdAt: nowIso(),
        rationale: "File changes were made successfully. No test failures detected.",
        revision: input.task.result?.revision,
        deterministicChecks: deterministicResult.checks
      };
    }

    if (deterministicResult.allPassed) {
      return {
        id: createId("eval"),
        taskId: input.task.id,
        verdict: "pass",
        confidence: 0.82,
        scores: { completion: 0.85, correctness: 0.82, scopeControl: 0.9, safety: 0.92, quality: 0.8, communication: 0.86 },
        findings: [],
        evidenceRefs,
        createdAt: nowIso(),
        rationale: "All deterministic checks passed. No issues detected.",
        revision: input.task.result?.revision,
        deterministicChecks: deterministicResult.checks
      };
    }
  }

  // Fallback: text-based keyword analysis
  if (text.includes("failed") || text.includes("error") || text.includes("blocked")) {
    return reviewRequired(input.task.id, ["Run summary indicates the task may need review."]);
  }

  return {
    id: createId("eval"),
    taskId: input.task.id,
    verdict: "pass",
    confidence: 0.88,
    scores: { completion: 0.9, correctness: 0.86, scopeControl: 0.9, safety: 0.92, quality: 0.84, communication: 0.86 },
    findings: [],
    evidenceRefs: ["run_summary"],
    createdAt: nowIso(),
    rationale: "The heuristic judge did not detect failure, blocking, or policy risk.",
    revision: input.task.result?.revision
  };
}

export interface DeterministicCheck {
  type: "tool_failure" | "permission_denied" | "tests" | "has_changes";
  pass: boolean;
  detail: string;
}

export interface DeterministicResult {
  checks: DeterministicCheck[];
  allPassed: boolean;
  hasFailures: boolean;
}

export interface VerdictInputs {
  llmJudgeVerdict?: JudgeVerdict;
  deterministicCheckVerdict?: JudgeVerdict;
  criteriaVerdict?: JudgeVerdict;
  humanReviewVerdict?: JudgeVerdict;
}

export function mergeVerdicts(inputs: VerdictInputs): JudgeVerdict {
  const verdicts = [
    inputs.humanReviewVerdict,
    inputs.deterministicCheckVerdict,
    inputs.criteriaVerdict,
    inputs.llmJudgeVerdict
  ].filter((verdict): verdict is JudgeVerdict => Boolean(verdict));

  if (verdicts.includes("fail")) {
    return "fail";
  }
  if (verdicts.includes("review_required")) {
    return "review_required";
  }
  return "pass";
}

export function deterministicVerdictFromChecks(result: DeterministicResult): JudgeVerdict {
  if (result.checks.some((check) => check.type === "tool_failure" && !check.pass)) {
    return "review_required";
  }
  if (result.checks.some((check) => check.type === "permission_denied" && !check.pass)) {
    return "review_required";
  }
  if (result.checks.some((check) => check.type === "tests" && !check.pass)) {
    return "review_required";
  }
  if (result.checks.some((check) => check.type === "has_changes" && !check.pass)) {
    return "review_required";
  }
  return "pass";
}

export function applyCanonicalVerdict(
  evaluation: Evaluation,
  inputs: VerdictInputs,
  context: { deterministicChecks?: DeterministicCheck[]; criteriaResults?: CriteriaResult[] } = {}
): Evaluation {
  const canonical = mergeVerdicts(inputs);
  const findings = [...evaluation.findings];
  if (canonical !== evaluation.verdict) {
    findings.push(`Canonical verdict ${canonical} overrode judge verdict ${evaluation.verdict}.`);
  }
  return {
    ...evaluation,
    verdict: canonical,
    overallVerdict: canonical,
    findings,
    deterministicChecks: context.deterministicChecks ?? evaluation.deterministicChecks,
    criteriaResults: context.criteriaResults ?? evaluation.criteriaResults
  };
}

export function runDeterministicChecks(task: Task, evidence: TaskEvidence[]): DeterministicResult {
  const checks: DeterministicCheck[] = [];

  // 1. Tool execution failures (excluding gitDiff which commonly fails in non-git dirs)
  const failedTools = evidence.filter((item) => isBlockingEvidence(item));
  if (failedTools.length > 0) {
    checks.push({
      type: "tool_failure",
      pass: false,
      detail: `${failedTools.length} tool(s) failed: ${failedTools.map((item) => `${item.toolName} - ${item.summary}`).join("; ")}`
    });
  }

  // 2. Permission denials
  const deniedTools = evidence.filter((item) => item.status === "denied");
  if (deniedTools.length > 0) {
    checks.push({
      type: "permission_denied",
      pass: false,
      detail: `${deniedTools.length} permission(s) denied: ${deniedTools.map((item) => item.summary).join("; ")}`
    });
  }

  // 3. Test results (if any test evidence exists)
  const testEvidence = evidence.filter((item) => item.toolName === "runTests");
  if (testEvidence.length > 0) {
    const lastTest = testEvidence.at(-1)!;
    checks.push({
      type: "tests",
      pass: isSuccessfulOutcome(lastTest),
      detail: lastTest.outcome?.summary ?? lastTest.summary
    });
  }

  // 4. File changes detection (only if task prompt suggests code modification)
  const isModificationTask = /\b(fix|edit|create|update|implement|add|remove|delete|write|refactor|change|modify)\b/i.test(task.prompt);
  if (isModificationTask) {
    const diffEvidence = evidence.filter((item) => item.toolName === "gitDiff" && item.status === "succeeded" && item.output?.trim());
    const writeEvidence = evidence.filter(
      (item) => (item.toolName === "writeFile" || item.toolName === "applyPatch") && item.status === "succeeded"
    );
    const hasChanges = diffEvidence.length > 0 || writeEvidence.length > 0;
    checks.push({
      type: "has_changes",
      pass: hasChanges,
      detail: hasChanges ? `${writeEvidence.length} file write(s), ${diffEvidence.length} diff(s)` : "No file changes detected for a modification task"
    });
  }

  const hasFailures = checks.some((check) => !check.pass);
  return {
    checks,
    allPassed: checks.length === 0 || checks.every((check) => check.pass),
    hasFailures
  };
}

function isNonBlockingQualityEvidence(item: TaskEvidence): boolean {
  const text = `${item.summary}\n${item.command ?? ""}\n${item.output ?? ""}`;
  return /pylint/u.test(text) && !/:\s+[FE]\d+:/u.test(text);
}

function isSuccessfulOutcome(item: TaskEvidence): boolean {
  return item.outcome
    ? item.outcome.semanticStatus === "success" || item.outcome.semanticStatus === "success_with_findings"
    : item.status === "succeeded";
}

function isBlockingEvidence(item: TaskEvidence): boolean {
  if (item.toolName === "gitDiff" || item.toolName === "policy") {
    return false;
  }
  if (item.outcome) {
    return item.outcome.blocksCompletion;
  }
  return item.status === "failed" && !isNonBlockingQualityEvidence(item);
}

export function computeVerdictFromCriteria(criteriaResults: CriteriaResult[]): JudgeVerdict {
  if (criteriaResults.length === 0) {
    return "review_required";
  }
  if (criteriaResults.some((criteria) => criteria.status === "fail")) {
    return "fail";
  }
  if (criteriaResults.some((criteria) => criteria.status === "unknown")) {
    return "review_required";
  }
  if (criteriaResults.every((criteria) => criteria.status === "pass")) {
    return "pass";
  }
  return "review_required";
}

export const judgePrompt = `You are Flint's task judge. Use only the provided task goal, run summary, diff summary, test results, and policy events. Return strict JSON with verdict, confidence, scores, findings, and evidenceRefs.`;

export const llmJudgePrompt = `You are Flint's task judge. Evaluate whether the result satisfies the original task goal using only the provided task goal, acceptance criteria, working directory, plan, step evidence, result, errors, tests, and policy events. Return strict JSON only with verdict, confidence, scores, findings, evidenceRefs, rationale, suggestedNextSteps, criteriaResults, missingEvidence, and judgeRationale. The core decision must be based on criteriaResults, not generic quality dimensions. Use verdict "pass" only when every acceptance criterion is pass with evidence. Use "review_required" when evidence is missing or a criterion is unknown.`;

function reviewRequired(taskId: string, findings: string[]): Evaluation {
  return {
    id: createId("eval"),
    taskId,
    verdict: "review_required",
    confidence: 0.55,
    scores: {
      completion: 0.5,
      correctness: 0.5,
      scopeControl: 0.5,
      safety: 0.5,
      quality: 0.5,
      communication: 0.5
    },
    findings,
    evidenceRefs: ["judge_fallback"],
    createdAt: nowIso(),
    rationale: findings.join(" ")
  };
}

function fail(taskId: string, findings: string[]): Evaluation {
  return { ...reviewRequired(taskId, findings), verdict: "fail", confidence: 0.8 };
}

function isVerdict(value: unknown): value is JudgeVerdict {
  return value === "pass" || value === "review_required" || value === "fail";
}

function clamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function parseCriteriaResults(value: unknown): CriteriaResult[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const results: CriteriaResult[] = [];
  for (const item of value) {
    const result = item as Partial<CriteriaResult>;
    if (
      typeof result.criteriaId === "string" &&
      typeof result.statement === "string" &&
      (result.status === "pass" || result.status === "fail" || result.status === "unknown")
    ) {
      results.push({
        criteriaId: result.criteriaId,
        statement: result.statement,
        status: result.status,
        rationale: typeof result.rationale === "string" ? result.rationale : "",
        evidenceRefs: Array.isArray(result.evidenceRefs) ? result.evidenceRefs.map(String) : [],
        nextSteps: Array.isArray(result.nextSteps) ? result.nextSteps.map(String) : undefined
      });
    }
  }
  return results.length ? results : undefined;
}

function normalizeCriterion(statement: string): string {
  const trimmed = statement.trim();
  if (/^(make|create|add|update|fix|implement|ensure|write|generate|delete|remove|run|test)\b/i.test(trimmed)) {
    return trimmed;
  }
  return `Satisfy: ${trimmed}`;
}

function inferVerificationMethod(statement: string): string {
  const lower = statement.toLowerCase();
  if (/(test|lint|typecheck|build|compile)/.test(lower)) {
    return "Verify with command/test evidence.";
  }
  if (/(file|code|edit|implement|fix|update|create|delete|remove)/.test(lower)) {
    return "Verify with file diff and step evidence.";
  }
  return "Verify with result summary and relevant tool evidence.";
}

function inferRequiredEvidence(statement: string): string[] {
  const lower = statement.toLowerCase();
  const evidence = ["result"];
  if (/(file|code|edit|implement|fix|update|create|delete|remove)/.test(lower)) {
    evidence.push("diff");
  }
  if (/(test|lint|typecheck|build|compile)/.test(lower)) {
    evidence.push("test_output");
  }
  return evidence;
}

export function extractVerdictFromText(raw: string): Partial<JudgeResult> {
  const result: Partial<JudgeResult> = {};
  const verdictMatch = raw.match(/verdict[\s:]+(?:is\s+)?["']?(pass|fail|review_required)["']?/i);
  if (verdictMatch) {
    const v = verdictMatch[1].toLowerCase();
    if (isVerdict(v)) {
      result.verdict = v;
    }
  }
  const confidenceMatch = raw.match(/confidence[\s:]+(\d+(?:\.\d+)?)/i);
  if (confidenceMatch) {
    const c = parseFloat(confidenceMatch[1]);
    if (Number.isFinite(c)) {
      result.confidence = Math.max(0, Math.min(1, c));
    }
  }
  return result;
}

function extractJson(rawOutput: string): string {
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let jsonText: string;
  if (fenced) {
    jsonText = fenced[1].trim();
  } else {
    const start = rawOutput.indexOf("{");
    const end = rawOutput.lastIndexOf("}");
    if (start >= 0 && end > start) {
      jsonText = rawOutput.slice(start, end + 1);
    } else {
      jsonText = rawOutput;
    }
  }

  // Remove single-line comments
  jsonText = jsonText.replace(/\/\/.*$/gm, '');
  // Remove block comments
  jsonText = jsonText.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove trailing commas before } or ]
  jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
  // Fix unquoted keys
  jsonText = jsonText.replace(/([{,])\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

  return jsonText;
}
