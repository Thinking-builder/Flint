import { describe, expect, it } from "vitest";
import type { Evaluation } from "@flint/core-types";
import { createProgressLedger, decideNextIteration, defaultIterationPolicy, normalizeIterationPolicy, updateProgressLedger } from "./iteration.js";

const evaluation = (overrides: Partial<Evaluation> = {}): Evaluation => ({
  id: "eval_1",
  taskId: "task_1",
  verdict: "review_required",
  confidence: 0.7,
  scores: {
    completion: 0.5,
    correctness: 0.5,
    scopeControl: 0.8,
    safety: 0.9,
    quality: 0.6,
    communication: 0.7
  },
  findings: ["Missing test evidence"],
  evidenceRefs: ["evd_1"],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

describe("iteration policy", () => {
  it("normalizes unsafe policy values", () => {
    const policy = normalizeIterationPolicy({ maxAttempts: 0, maxToolIterationsPerStep: 0, maxTotalToolCalls: 0 });
    expect(policy.maxAttempts).toBe(1);
    expect(policy.maxToolIterationsPerStep).toBe(1);
    expect(policy.maxTotalToolCalls).toBe(1);
  });

  it("updates the progress ledger from checks and findings", () => {
    const ledger = updateProgressLedger(createProgressLedger(), evaluation(), {
      deterministicChecks: [{ type: "tests", pass: false, detail: "npm test failed" }],
      criteriaResults: [{ criteriaId: "ac_1", statement: "Run tests", status: "unknown", rationale: "No output", evidenceRefs: [] }]
    });
    expect(ledger.score).toBeGreaterThan(0);
    expect(ledger.failedChecks.map((check) => check.name)).toContain("deterministic:tests");
    expect(ledger.openFindings.some((finding) => finding.summary.includes("Missing test evidence"))).toBe(true);
    expect(ledger.currentHypotheses[0].summary).toContain("deterministic:tests");
  });

  it("continues while budget remains and progress is not stagnant", () => {
    const policy = normalizeIterationPolicy({ maxAttempts: 3, stagnationWindow: 3 });
    const ledger = updateProgressLedger(createProgressLedger(), evaluation(), {
      deterministicChecks: [{ type: "tests", pass: false, detail: "npm test failed" }],
      policy
    });
    expect(decideNextIteration(policy, ledger, evaluation(), 1).action).toBe("continue");
  });

  it("requires review after max attempts", () => {
    const policy = normalizeIterationPolicy({ maxAttempts: 2 });
    const ledger = updateProgressLedger(createProgressLedger(), evaluation(), { policy });
    expect(decideNextIteration(policy, ledger, evaluation(), 2)).toMatchObject({ action: "review_required" });
  });

  it("requires review when progress stagnates", () => {
    const policy = normalizeIterationPolicy({ ...defaultIterationPolicy, minProgressDelta: 0.2, stagnationWindow: 1 });
    const previous = { ...createProgressLedger(), score: 0.6, scoreHistory: [0.6] };
    const ledger = updateProgressLedger(previous, evaluation(), { policy });
    expect(decideNextIteration(policy, ledger, evaluation(), 1)).toMatchObject({ action: "review_required" });
  });
});
