import { describe, expect, it } from "vitest";
import { computeVerdictFromCriteria, deriveAcceptanceCriteria, extractVerdictFromText, parseJudgeOutput, parseJudgeResult, runDeterministicChecks, runHeuristicJudge } from "./index.js";
import type { Task, TaskEvidence, CriteriaResult } from "@flint/core-types";

const task: Task = {
  id: "task_1",
  title: "Test",
  prompt: "Test prompt",
  status: "judging",
  priority: "P2",
  workspaceId: "workspace",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("judge", () => {
  it("falls back to review_required when JSON cannot be parsed", () => {
    expect(parseJudgeOutput("task_1", "not json").verdict).toBe("review_required");
  });

  it("parses LLM judge JSON with suggested next steps", () => {
    const result = parseJudgeResult(
      '{"verdict":"review_required","confidence":0.7,"scores":{"completion":0.5,"correctness":0.4,"scopeControl":0.8,"safety":0.9,"quality":0.5,"communication":0.6},"findings":["Missing result"],"evidenceRefs":["result"],"rationale":"Needs another pass","suggestedNextSteps":[{"title":"Revise result","detail":"Add missing content"}],"criteriaResults":[{"criteriaId":"ac_1","statement":"Add result","status":"unknown","rationale":"No evidence","evidenceRefs":[]}],"missingEvidence":["diff"],"judgeRationale":"Missing evidence"}'
    );
    expect(result.verdict).toBe("review_required");
    expect(result.suggestedNextSteps?.[0]?.title).toBe("Revise result");
    expect(result.criteriaResults?.[0]?.status).toBe("unknown");
  });

  it("derives acceptance criteria from the task prompt", () => {
    const criteria = deriveAcceptanceCriteria({ ...task, prompt: "Update the UI. Run tests." });
    expect(criteria).toHaveLength(2);
    expect(criteria[0].requiredEvidence).toContain("diff");
    expect(criteria[1].requiredEvidence).toContain("test_output");
  });

  it("passes clean summaries", () => {
    expect(runHeuristicJudge({ task, runSummary: "Completed successfully" }).verdict).toBe("pass");
  });

  it("fails policy-risk summaries", () => {
    expect(runHeuristicJudge({ task, runSummary: "dangerous command attempted" }).verdict).toBe("fail");
  });

  it("passes with high confidence when writes succeed and tests pass", () => {
    const result = runHeuristicJudge({
      task: { ...task, prompt: "Fix the bug" },
      runSummary: "Done",
      evidence: [
        { id: "evd_1", taskId: "task_1", toolName: "writeFile", status: "succeeded", summary: "Wrote file", timestamp: "t" },
        { id: "evd_2", taskId: "task_1", toolName: "runTests", status: "succeeded", summary: "Tests pass", timestamp: "t" }
      ]
    });
    expect(result.verdict).toBe("pass");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("returns review_required when tests fail", () => {
    const result = runHeuristicJudge({
      task,
      runSummary: "Done",
      evidence: [
        { id: "evd_1", taskId: "task_1", toolName: "writeFile", status: "succeeded", summary: "Wrote file", timestamp: "t" },
        { id: "evd_2", taskId: "task_1", toolName: "runTests", status: "failed", summary: "Tests fail", timestamp: "t" }
      ]
    });
    expect(result.verdict).toBe("review_required");
  });

  it("returns review_required when permissions are denied", () => {
    const result = runHeuristicJudge({
      task,
      runSummary: "Done",
      evidence: [
        { id: "evd_1", taskId: "task_1", toolName: "policy", status: "denied", summary: "Write denied", timestamp: "t" }
      ]
    });
    expect(result.verdict).toBe("review_required");
  });

  it("handles trailing commas in judge JSON", () => {
    const result = parseJudgeResult('{"verdict":"pass","confidence":0.9,"scores":{"completion":0.9,"correctness":0.9,"scopeControl":0.9,"safety":0.9,"quality":0.9,"communication":0.9,},"findings":[],"evidenceRefs":[],}');
    expect(result.verdict).toBe("pass");
  });

  it("handles unquoted keys in judge JSON", () => {
    const result = parseJudgeResult('{verdict:"pass",confidence:0.9,scores:{completion:0.9,correctness:0.9,scopeControl:0.9,safety:0.9,quality:0.9,communication:0.9},findings:[],evidenceRefs:[]}');
    expect(result.verdict).toBe("pass");
  });

  it("extracts verdict from text when JSON fails completely", () => {
    const evaluation = parseJudgeOutput("task_1", 'The task was completed successfully. My verdict is "pass" with confidence 0.85. The code changes look correct.');
    expect(evaluation.verdict).toBe("pass");
    expect(evaluation.confidence).toBeGreaterThan(0.5);
  });

  it("handles JSON wrapped in markdown with extra text", () => {
    const result = parseJudgeResult('Here is my evaluation:\n\n```json\n{"verdict":"review_required","confidence":0.7,"scores":{"completion":0.5,"correctness":0.4,"scopeControl":0.8,"safety":0.9,"quality":0.5,"communication":0.6},"findings":["Needs work"],"evidenceRefs":["result"]}\n```\n\nLet me know if you have questions.');
    expect(result.verdict).toBe("review_required");
  });
});

describe("deterministic checks", () => {
  const evidence = (overrides: Partial<TaskEvidence>): TaskEvidence => ({
    id: "evd_1",
    taskId: "task_1",
    toolName: "readFile",
    status: "succeeded",
    summary: "test",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides
  });

  it("detects tool failures", () => {
    const result = runDeterministicChecks(task, [
      evidence({ toolName: "writeFile", status: "failed", summary: "Write failed" })
    ]);
    expect(result.hasFailures).toBe(true);
    expect(result.checks.find((c) => c.type === "tool_failure")?.pass).toBe(false);
  });

  it("detects permission denials", () => {
    const result = runDeterministicChecks(task, [
      evidence({ toolName: "policy", status: "denied", summary: "Write denied" })
    ]);
    expect(result.hasFailures).toBe(true);
    expect(result.checks.find((c) => c.type === "permission_denied")?.pass).toBe(false);
  });

  it("checks test results", () => {
    const result = runDeterministicChecks(task, [
      evidence({ toolName: "runTests", status: "succeeded", summary: "All tests pass" })
    ]);
    expect(result.checks.find((c) => c.type === "tests")?.pass).toBe(true);
  });

  it("detects missing changes for modification tasks", () => {
    const modTask = { ...task, prompt: "Fix the login bug" };
    const result = runDeterministicChecks(modTask, [
      evidence({ toolName: "readFile", status: "succeeded" })
    ]);
    expect(result.checks.find((c) => c.type === "has_changes")?.pass).toBe(false);
  });

  it("detects successful writes as changes", () => {
    const modTask = { ...task, prompt: "Update the config file" };
    const result = runDeterministicChecks(modTask, [
      evidence({ toolName: "writeFile", status: "succeeded", summary: "Wrote config.json" })
    ]);
    expect(result.checks.find((c) => c.type === "has_changes")?.pass).toBe(true);
  });

  it("returns allPassed when no issues found", () => {
    const result = runDeterministicChecks(task, [
      evidence({ toolName: "readFile", status: "succeeded" })
    ]);
    expect(result.allPassed).toBe(true);
    expect(result.hasFailures).toBe(false);
  });
});

describe("computeVerdictFromCriteria", () => {
  const criteria = (status: "pass" | "fail" | "unknown"): CriteriaResult => ({
    criteriaId: "ac_1",
    statement: "Test criterion",
    status,
    rationale: "test",
    evidenceRefs: []
  });

  it("returns pass when all criteria pass", () => {
    expect(computeVerdictFromCriteria([criteria("pass"), criteria("pass")])).toBe("pass");
  });

  it("returns fail when any criterion fails", () => {
    expect(computeVerdictFromCriteria([criteria("pass"), criteria("fail")])).toBe("fail");
  });

  it("returns review_required when any criterion is unknown", () => {
    expect(computeVerdictFromCriteria([criteria("pass"), criteria("unknown")])).toBe("review_required");
  });

  it("returns review_required for empty criteria", () => {
    expect(computeVerdictFromCriteria([])).toBe("review_required");
  });
});
