import type { Agent, Task } from "@flint/core-types";

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

    const nextTask = tasks
      .filter((task) => task.status === "queued")
      .sort((a, b) => {
        const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
        return priorityDiff || a.createdAt.localeCompare(b.createdAt);
      })[0];

    return nextTask ? { task: nextTask, agent: idleAgent } : undefined;
  }
}
