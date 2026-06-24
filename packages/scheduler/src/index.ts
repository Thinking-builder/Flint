import type { Agent, ResourceLock, Task } from "@flint/core-types";

const priorityRank: Record<Task["priority"], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

export class Scheduler {
  constructor(private readonly maxConcurrentTasks: number) {}

  selectNext(tasks: Task[], agents: Agent[]): { task: Task; agent: Agent } | undefined {
    const runningCount = agents.filter((agent) => agent.status === "running" || agent.status === "reserved").length;
    if (runningCount >= this.maxConcurrentTasks) {
      return undefined;
    }

    const idleAgent = agents.find((agent) => agent.status === "idle");
    if (!idleAgent) {
      return undefined;
    }

    const activeLocks = tasks
      .filter((task) => isActiveTask(task))
      .flatMap((task) => task.resourceLocks ?? []);

    const nextTask = tasks
      .filter((task) => task.status === "queued")
      .filter((task) => !locksConflictWithAny(task.resourceLocks ?? [], activeLocks))
      .sort((a, b) => {
        const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
        return priorityDiff || a.createdAt.localeCompare(b.createdAt);
      })[0];

    return nextTask ? { task: nextTask, agent: idleAgent } : undefined;
  }
}

export function locksConflict(a: ResourceLock, b: ResourceLock): boolean {
  if (a.mode === "read" && b.mode === "read") {
    return false;
  }
  if (a.type === "terminal" || b.type === "terminal") {
    return a.type === b.type;
  }
  if (a.type === "workspace" || b.type === "workspace") {
    return sameWorkspaceScope(a, b);
  }
  if (a.type === "git-worktree" || b.type === "git-worktree") {
    return a.type === b.type && normalizePath(a.path) === normalizePath(b.path);
  }
  return pathsOverlap(a, b);
}

function locksConflictWithAny(requested: ResourceLock[], active: ResourceLock[]): boolean {
  return requested.some((lock) => active.some((activeLock) => locksConflict(lock, activeLock)));
}

function isActiveTask(task: Task): boolean {
  return task.status === "dispatching" || task.status === "planning" || task.status === "running" || task.status === "judging" || task.status === "waiting_user";
}

function sameWorkspaceScope(a: ResourceLock, b: ResourceLock): boolean {
  if (!a.path || !b.path) {
    return true;
  }
  return normalizePath(a.path) === normalizePath(b.path);
}

function pathsOverlap(a: ResourceLock, b: ResourceLock): boolean {
  const left = normalizePath(a.path);
  const right = normalizePath(b.path);
  if (!left || !right) {
    return a.type === b.type;
  }
  if (left === right) {
    return true;
  }
  if (a.type === "directory" || b.type === "directory") {
    return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }
  return false;
}

function normalizePath(path: string | undefined): string | undefined {
  return path?.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
