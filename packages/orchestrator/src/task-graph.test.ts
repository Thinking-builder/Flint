import { describe, expect, it } from "vitest";
import type { TaskPlan } from "@flint/core-types";
import { taskGraphFromPlan } from "./task-graph.js";

describe("taskGraphFromPlan", () => {
  it("converts linear plan steps into a compatible DAG", () => {
    const plan: TaskPlan = {
      createdAt: "2026-01-01T00:00:00.000Z",
      summary: "Plan",
      steps: [
        { id: "step_1", index: 1, title: "Edit code", detail: "Update the implementation", status: "planned" },
        { id: "step_2", index: 2, title: "Run tests", status: "planned" }
      ]
    };
    const graph = taskGraphFromPlan(plan, { resourceLocks: [{ type: "file", path: "src/index.ts", mode: "write" }] });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0].dependsOn).toEqual([]);
    expect(graph.nodes[1].dependsOn).toEqual(["node_step_1"]);
    expect(graph.nodes[0].requiredEvidence).toContain("diff");
    expect(graph.nodes[1].verification.some((spec) => spec.kind === "test")).toBe(true);
    expect(graph.nodes[0].resourceLocks[0].path).toBe("src/index.ts");
  });
});
