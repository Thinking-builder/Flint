import { describe, expect, it } from "vitest";
import type { Agent, Task } from "@flint/core-types";
import { locksConflict, Scheduler } from "./index.js";

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

  it("does not schedule a queued task whose write lock conflicts with an active task", () => {
    const active = {
      ...task("t1", "P2"),
      status: "running" as const,
      resourceLocks: [{ type: "file" as const, path: "src/index.ts", mode: "write" as const }]
    };
    const blocked = {
      ...task("t2", "P0"),
      resourceLocks: [{ type: "file" as const, path: "src/index.ts", mode: "write" as const }]
    };
    const free = {
      ...task("t3", "P1"),
      resourceLocks: [{ type: "file" as const, path: "src/other.ts", mode: "write" as const }]
    };
    const result = new Scheduler(2).selectNext([active, blocked, free], [agent("running"), agent("idle")]);
    expect(result?.task.id).toBe("t3");
  });

  it("allows concurrent read locks on the same file", () => {
    expect(
      locksConflict(
        { type: "file", path: "src/index.ts", mode: "read" },
        { type: "file", path: "src/index.ts", mode: "read" }
      )
    ).toBe(false);
  });

  it("treats directory write locks as conflicting with child file writes", () => {
    expect(
      locksConflict(
        { type: "directory", path: "src", mode: "write" },
        { type: "file", path: "src/index.ts", mode: "write" }
      )
    ).toBe(true);
  });
});
