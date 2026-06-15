import { describe, expect, it } from "vitest";
import type { Agent, Task } from "@flint/core-types";
import { Scheduler } from "./index.js";

const task = (id: string, priority: Task["priority"] = "P2"): Task => ({
  id,
  title: id,
  prompt: id,
  status: "queued",
  priority,
  workspaceId: "workspace",
  createdAt: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
  updatedAt: "2026-01-01T00:00:00.000Z"
});

const agent = (status: Agent["status"]): Agent => ({
  id: `agent-${status}`,
  name: "Agent",
  provider: "mock",
  model: "mock",
  status,
  capabilities: ["code"]
});

describe("Scheduler", () => {
  it("selects the highest-priority queued task and an idle agent", () => {
    const result = new Scheduler(2).selectNext([task("t1", "P3"), task("t2", "P0")], [agent("idle")]);
    expect(result?.task.id).toBe("t2");
  });

  it("does not treat waiting_user agents as idle", () => {
    const result = new Scheduler(2).selectNext([task("t1")], [agent("waiting_user")]);
    expect(result).toBeUndefined();
  });

  it("honors the max concurrent task limit", () => {
    const result = new Scheduler(1).selectNext([task("t1")], [agent("running"), agent("idle")]);
    expect(result).toBeUndefined();
  });
});
