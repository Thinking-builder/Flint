import { nowIso, type ResourceLock, type TaskGraph, type TaskGraphNode, type TaskPlan, type VerificationSpec, type WorkspaceToolName } from "@flint/core-types";

const defaultAllowedTools: WorkspaceToolName[] = [
  "glob",
  "grep",
  "readFile",
  "listFiles",
  "writeFile",
  "applyPatch",
  "runCommand",
  "environmentCheck",
  "getDiagnostics",
  "gitDiff",
  "runTests"
];

export function taskGraphFromPlan(plan: TaskPlan, options: { resourceLocks?: ResourceLock[] } = {}): TaskGraph {
  return {
    createdAt: nowIso(),
    summary: plan.summary,
    nodes: plan.steps.map((step, index): TaskGraphNode => ({
      id: `node_${step.id}`,
      title: step.title,
      objective: step.detail ?? step.title,
      dependsOn: index === 0 ? [] : [`node_${plan.steps[index - 1].id}`],
      status: step.status === "planned" ? "planned" : step.status,
      requiredEvidence: requiredEvidenceForStep(step.title, step.detail),
      allowedTools: defaultAllowedTools,
      resourceLocks: options.resourceLocks ?? [],
      verification: verificationForStep(step.title, step.detail),
      sourceStepId: step.id
    }))
  };
}

function requiredEvidenceForStep(title: string, detail?: string): string[] {
  const text = `${title}\n${detail ?? ""}`.toLowerCase();
  const evidence = ["step_summary"];
  if (/write|patch|edit|implement|fix|update|create|delete|remove|diff/u.test(text)) {
    evidence.push("diff");
  }
  if (/test|lint|typecheck|build|compile/u.test(text)) {
    evidence.push("test_output");
  }
  return evidence;
}

function verificationForStep(title: string, detail?: string): VerificationSpec[] {
  const text = `${title}\n${detail ?? ""}`.toLowerCase();
  const specs: VerificationSpec[] = [{ kind: "manual", required: true, expectedEvidence: ["step_summary"] }];
  if (/test|unit|vitest|pytest/u.test(text)) {
    specs.push({ kind: "test", required: true, expectedEvidence: ["test_output"] });
  }
  if (/lint/u.test(text)) {
    specs.push({ kind: "lint", required: true, expectedEvidence: ["test_output"] });
  }
  if (/typecheck|tsc/u.test(text)) {
    specs.push({ kind: "typecheck", required: true, expectedEvidence: ["test_output"] });
  }
  if (/build|compile/u.test(text)) {
    specs.push({ kind: "build", required: true, expectedEvidence: ["test_output"] });
  }
  return specs;
}
