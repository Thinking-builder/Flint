import { describe, expect, it } from "vitest";
import { formatTaskContext, MockProvider, parsePlanResult } from "./index.js";
import type { Task } from "@flint/core-types";

const task: Task = {
  id: "task_1",
  title: "Test task",
  prompt: "Do work",
  status: "planning",
  priority: "P2",
  workspaceId: "workspace",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("providers", () => {
  it("mock provider returns a stable 3-step plan", async () => {
    const result = await new MockProvider().plan({ task, signal: new AbortController().signal });
    expect(result.steps.map((step) => step.title)).toEqual(["Understand task", "Execute task", "Summarize result"]);
  });

  it("parses valid JSON plans", () => {
    const result = parsePlanResult('{"summary":"Plan","steps":[{"title":"One"},{"title":"Two","detail":"Do two"}]}');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].detail).toBe("Do two");
  });

  it("rejects invalid plan JSON and malformed step arrays", () => {
    expect(() => parsePlanResult("not json")).toThrow();
    expect(() => parsePlanResult('{"summary":"Plan","steps":[{"title":"Only one"}]}')).toThrow();
  });

  it("includes the task working directory in provider context", () => {
    const context = formatTaskContext(task);
    expect(context).toContain("Working directory: workspace");
    expect(context).toContain("Do not ask the user which directory to use");
  });

  it("mock judge returns a stable pass result", async () => {
    const result = await new MockProvider().judge({
      task,
      result: {
        format: "markdown",
        content: "# Done",
        summary: "Done",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceStepIds: [],
        revision: 1
      },
      runSummary: "Done",
      signal: new AbortController().signal
    });
    expect(result.verdict).toBe("pass");
  });

  it("mock judge can request another iteration", async () => {
    const result = await new MockProvider().judge({
      task: { ...task, prompt: "[[judge-review]] Do work" },
      result: {
        format: "markdown",
        content: "# Needs work",
        summary: "Needs work",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceStepIds: [],
        revision: 1
      },
      runSummary: "Needs work",
      signal: new AbortController().signal
    });
    expect(result.verdict).toBe("review_required");
    expect(result.suggestedNextSteps?.[0]?.title).toBe("Address evaluation finding");
  });

  it("parses tool calls from JSON run output", async () => {
    const provider = new JsonToolProvider();
    const result = await provider.run({
      task,
      signal: new AbortController().signal
    });
    expect(result.summary).toBe("Edit file");
    expect(result.toolCalls?.[0]?.name).toBe("writeFile");
  });
});

class JsonToolProvider extends MockProvider {
  override async run() {
    return {
      summary: "Edit file",
      rawOutput: '{"summary":"Edit file","toolCalls":[{"name":"writeFile","input":{"path":"a.txt","content":"hello"}}]}',
      toolCalls: [{ name: "writeFile" as const, input: { path: "a.txt", content: "hello" } }]
    };
  }
}
