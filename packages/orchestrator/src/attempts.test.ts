import { describe, expect, it } from "vitest";
import { finishAttempt, startAttempt } from "./attempts.js";

describe("attempt records", () => {
  it("records strategy, verification results, patch summary, and score", () => {
    const attempt = startAttempt("task_1", "minimal repair", 100);
    const finished = finishAttempt(attempt, {
      status: "completed",
      patchSummary: "Updated src/index.ts",
      verificationResults: [{ id: "check_1", name: "npm test", status: "pass", summary: "passed", evidenceRefs: ["evd_1"] }],
      score: 0.88,
      finishedAt: 200
    });
    expect(finished.strategy).toBe("minimal repair");
    expect(finished.status).toBe("completed");
    expect(finished.patchSummary).toContain("src/index.ts");
    expect(finished.verificationResults[0].status).toBe("pass");
    expect(finished.score).toBe(0.88);
  });
});
