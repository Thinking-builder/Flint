import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileStorage } from "./index.js";
import type { Evaluation, Task, TaskEvent } from "@flint/core-types";

let tempDirs: string[] = [];

async function createStorage(): Promise<FileStorage> {
  const dir = await mkdtemp(join(tmpdir(), "flint-storage-test-"));
  tempDirs.push(dir);
  const storage = new FileStorage(join(dir, "state.json"));
  await storage.init();
  return storage;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("FileStorage", () => {
  it("deletes a task with its events and evaluation", async () => {
    const storage = await createStorage();
    const task: Task = {
      id: "task_1",
      title: "Task",
      prompt: "Do work",
      status: "completed",
      priority: "P2",
      workspaceId: "workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const event: TaskEvent = {
      id: "evt_1",
      taskId: task.id,
      type: "task.finished",
      payload: {},
      timestamp: "2026-01-01T00:00:01.000Z"
    };
    const evaluation: Evaluation = {
      id: "eval_1",
      taskId: task.id,
      verdict: "pass",
      confidence: 0.9,
      scores: {
        completion: 1,
        correctness: 1,
        scopeControl: 1,
        safety: 1,
        quality: 1,
        communication: 1
      },
      findings: [],
      evidenceRefs: [],
      createdAt: "2026-01-01T00:00:02.000Z"
    };

    await storage.upsertTask(task);
    await storage.appendEvent(event);
    await storage.upsertEvaluation(evaluation);
    await storage.deleteTask(task.id);

    expect(await storage.getTask(task.id)).toBeUndefined();
    expect(await storage.listEvents(task.id)).toEqual([]);
    expect(await storage.getEvaluation(task.id)).toBeUndefined();
  });

  it("is idempotent when deleting an unknown task", async () => {
    const storage = await createStorage();
    await expect(storage.deleteTask("missing")).resolves.toBeUndefined();
  });
});
