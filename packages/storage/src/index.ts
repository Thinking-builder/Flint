import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Evaluation, Task, TaskEvent, TaskFilter } from "@flint/core-types";

export interface FlintStorage {
  init(): Promise<void>;
  upsertTask(task: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  appendEvent(event: TaskEvent): Promise<void>;
  listEvents(taskId: string): Promise<TaskEvent[]>;
  upsertEvaluation(evaluation: Evaluation): Promise<void>;
  getEvaluation(taskId: string): Promise<Evaluation | undefined>;
}

interface StateFile {
  tasks: Task[];
  events: TaskEvent[];
  evaluations: Evaluation[];
}

const emptyState = (): StateFile => ({ tasks: [], events: [], evaluations: [] });

export class FileStorage implements FlintStorage {
  private state: StateFile = emptyState();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw) as StateFile;
    } catch {
      this.state = emptyState();
      await this.flush();
    }
  }

  async upsertTask(task: Task): Promise<void> {
    const index = this.state.tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) {
      this.state.tasks[index] = task;
    } else {
      this.state.tasks.push(task);
    }
    await this.flush();
  }

  async deleteTask(id: string): Promise<void> {
    this.state.tasks = this.state.tasks.filter((task) => task.id !== id);
    this.state.events = this.state.events.filter((event) => event.taskId !== id);
    this.state.evaluations = this.state.evaluations.filter((evaluation) => evaluation.taskId !== id);
    await this.flush();
  }

  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    return this.state.tasks
      .filter((task) => !filter?.workspaceId || task.workspaceId === filter.workspaceId)
      .filter((task) => !filter?.statuses || filter.statuses.includes(task.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.state.tasks.find((task) => task.id === id);
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    this.state.events.push(event);
    await this.flush();
  }

  async listEvents(taskId: string): Promise<TaskEvent[]> {
    return this.state.events
      .filter((event) => event.taskId === taskId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async upsertEvaluation(evaluation: Evaluation): Promise<void> {
    const index = this.state.evaluations.findIndex((item) => item.taskId === evaluation.taskId);
    if (index >= 0) {
      this.state.evaluations[index] = evaluation;
    } else {
      this.state.evaluations.push(evaluation);
    }
    await this.flush();
  }

  async getEvaluation(taskId: string): Promise<Evaluation | undefined> {
    return this.state.evaluations.find((item) => item.taskId === taskId);
  }

  private async flush(): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}

export async function createStorage(filePath: string): Promise<FlintStorage> {
  const storage = new FileStorage(filePath);
  await storage.init();
  return storage;
}
