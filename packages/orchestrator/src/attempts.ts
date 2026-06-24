import { createId, type Attempt, type CheckResult } from "@flint/core-types";

export function startAttempt(taskId: string, strategy: string, startedAt = Date.now()): Attempt {
  return {
    id: createId("attempt"),
    taskId,
    strategy,
    status: "running",
    startedAt,
    verificationResults: []
  };
}

export function finishAttempt(
  attempt: Attempt,
  options: {
    status: Attempt["status"];
    patchSummary?: string;
    verificationResults?: CheckResult[];
    score?: number;
    finishedAt?: number;
  }
): Attempt {
  return {
    ...attempt,
    status: options.status,
    patchSummary: options.patchSummary,
    verificationResults: options.verificationResults ?? attempt.verificationResults,
    score: options.score,
    finishedAt: options.finishedAt ?? Date.now()
  };
}
