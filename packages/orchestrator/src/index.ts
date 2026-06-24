import {
  createId,
  nowIso,
  type Agent,
  type CreateTaskInput,
  type Disposable,
  type Evaluation,
  type IterationPolicy,
  type ProgressLedger,
  type ProviderAdapter,
  type Reflection,
  type ResourceLock,
  type TaskPermissions,
  type Task,
  type TaskDetail,
  type TaskEvidence,
  type TaskEvent,
  type TaskFilter,
  type TaskPermissionMode,
  type TaskPlan,
  type TaskPlanStep,
  type TaskResult,
  type ToolPermissionDecision,
  type ToolPermissionRequest,
  type ToolPermissionScope,
  type UserInputRequest,
  type WorkspaceToolCall
} from "@flint/core-types";
import {
  applyCanonicalVerdict,
  computeVerdictFromCriteria,
  deriveAcceptanceCriteria,
  deterministicVerdictFromChecks,
  evaluationFromJudgeResult,
  runDeterministicChecks,
  runHeuristicJudge
} from "@flint/judge";
import { Scheduler } from "@flint/scheduler";
import type { FlintStorage } from "@flint/storage";
import { WorkspaceTools, type DiagnosticsResolver } from "@flint/workspace-tools";
import { finishAttempt, startAttempt } from "./attempts.js";
import { createProgressLedger, decideNextIteration, normalizeIterationPolicy, updateProgressLedger } from "./iteration.js";
import { taskGraphFromPlan } from "./task-graph.js";

export interface OrchestratorOptions {
  storage: FlintStorage;
  providers: ProviderAdapter[];
  workspaceId: string;
  workspaceIds?: string[];
  maxConcurrentTasks: number;
  defaultPermissionMode?: TaskPermissionMode;
  allowFileWrites?: boolean;
  allowTerminalCommands?: boolean;
  testCommand?: string;
  iterationPolicy?: Partial<IterationPolicy>;
  diagnosticsResolver?: DiagnosticsResolver;
  requestToolPermission?: (request: ToolPermissionRequest, task: Task) => Promise<ToolPermissionDecision>;
}

type EventHandler = (event: TaskEvent) => void;
type TaskPlanStepSuggestion = NonNullable<import("@flint/core-types").Evaluation["suggestedNextSteps"]>[number];

export class FlintOrchestrator {
  private agents: Agent[];
  private readonly scheduler: Scheduler;
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private paused = false;

  constructor(private readonly options: OrchestratorOptions) {
    this.scheduler = new Scheduler(options.maxConcurrentTasks);
    this.agents = options.providers.map((provider) => ({
      id: `agent_${provider.id}`,
      name: provider.id,
      provider: provider.id,
      model: provider.model,
      status: "idle",
      capabilities: ["code", "review"]
    }));
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const timestamp = nowIso();
    const task: Task = {
      id: createId("task"),
      title: input.title,
      prompt: input.prompt,
      status: "queued",
      priority: input.priority ?? "P2",
      workspaceId: input.workspaceId,
      budget: input.budget,
      permissions: this.createTaskPermissions(input.permissionMode ?? this.options.defaultPermissionMode ?? "ask"),
      iterationPolicy: normalizeIterationPolicy({ ...this.options.iterationPolicy, ...input.iterationPolicy }),
      progressLedger: createProgressLedger(),
      resourceLocks: input.resourceLocks ?? inferResourceLocks(input.prompt),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.options.storage.upsertTask(task);
    await this.record(task.id, "task.created", { title: task.title });
    void this.tick();
    return task;
  }

  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    return this.options.storage.listTasks(filter);
  }

  async getTask(id: string): Promise<TaskDetail> {
    const task = await this.options.storage.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return {
      task,
      events: await this.options.storage.listEvents(id),
      evaluation: await this.options.storage.getEvaluation(id)
    };
  }

  async cancelTask(id: string): Promise<void> {
    const task = await this.requireTask(id);
    this.abortControllers.get(id)?.abort();
    const updated = this.withStatus(task, "cancelled", { finishedAt: nowIso() });
    await this.options.storage.upsertTask(updated);
    this.releaseAgentForTask(id);
    await this.persistReflection(updated, undefined, ["task cancelled"]);
    await this.record(id, "task.cancelled", {});
    void this.tick();
  }

  async deleteTask(id: string): Promise<void> {
    this.abortControllers.get(id)?.abort();
    this.abortControllers.delete(id);
    this.releaseAgentForTask(id);
    await this.options.storage.deleteTask(id);
    void this.tick();
  }

  async retryTask(id: string): Promise<Task> {
    const task = await this.requireTask(id);
    const updated = this.withStatus(task, "queued", {
      agentId: undefined,
      finishedAt: undefined,
      lastError: undefined,
      userInputRequest: undefined,
      plan: undefined,
      currentStepId: undefined,
      result: undefined,
      evaluationAttempts: undefined,
      progressLedger: createProgressLedger(),
      attempts: undefined,
      taskGraph: undefined
    });
    await this.options.storage.upsertTask(updated);
    await this.record(id, "task.requeued", {});
    void this.tick();
    return updated;
  }

  async updateTaskPermissions(id: string, mode: TaskPermissionMode): Promise<Task> {
    const task = await this.requireTask(id);
    const updated = {
      ...task,
      permissions: this.createTaskPermissions(mode, mode === "full_access" ? ["file_write", "terminal"] : []),
      updatedAt: nowIso()
    };
    await this.options.storage.upsertTask(updated);
    await this.record(id, "permission.mode_changed", { mode });
    return updated;
  }

  async respondToUserInput(taskId: string, response: string): Promise<void> {
    const task = await this.requireTask(taskId);
    if (task.status !== "waiting_user") {
      throw new Error(`Task ${taskId} is not waiting for user input`);
    }
    const updated = this.withStatus(task, "running", {
      prompt: `${task.prompt}\n\nUser response: ${response}`,
      userInputRequest: undefined
    });
    await this.options.storage.upsertTask(updated);
    await this.record(taskId, "user.responded", { response });
    void this.runSteps(updated);
  }

  subscribeTaskEvents(taskId: string | "all", handler: EventHandler): Disposable {
    const existing = this.handlers.get(taskId) ?? new Set<EventHandler>();
    existing.add(handler);
    this.handlers.set(taskId, existing);
    return {
      dispose: () => existing.delete(handler)
    };
  }

  pauseAll(): void {
    this.paused = true;
  }

  resumeAll(): void {
    this.paused = false;
    void this.tick();
  }

  getAgents(): Agent[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  private async tick(): Promise<void> {
    if (this.paused) {
      return;
    }
    const tasks = await this.listRunnableWorkspaceTasks();
    let next = this.scheduler.selectNext(tasks, this.agents);
    while (next) {
      const agent = next.agent;
      const task = next.task;
      this.setAgent(agent.id, { status: "reserved", taskId: task.id, leaseUntil: new Date(Date.now() + 30_000).toISOString() });
      const dispatching = this.withStatus(task, "dispatching", { agentId: agent.id });
      await this.options.storage.upsertTask(dispatching);
      await this.record(task.id, "task.dispatching", { agentId: agent.id });
      void this.runTask(dispatching);
      next = this.scheduler.selectNext(await this.listRunnableWorkspaceTasks(), this.agents);
    }
  }

  private async listRunnableWorkspaceTasks(): Promise<Task[]> {
    const workspaceIds = this.options.workspaceIds?.length ? this.options.workspaceIds : [this.options.workspaceId];
    const tasks = await this.options.storage.listTasks();
    return tasks.filter((task) => workspaceIds.includes(task.workspaceId));
  }

  private async runTask(task: Task): Promise<void> {
    const provider = this.options.providers.find((item) => `agent_${item.id}` === task.agentId) ?? this.options.providers[0];
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);
    this.setAgent(task.agentId, { status: "running", taskId: task.id });

    try {
      let planning = this.withStatus(task, "planning", { startedAt: task.startedAt ?? nowIso() });
      await this.options.storage.upsertTask(planning);
      await this.record(task.id, "task.planning", { providerId: provider.id, model: provider.model });

      // Auto-explore workspace before planning so the agent knows what exists
      planning = await this.collectWorkspaceSnapshot(planning);
      await this.options.storage.upsertTask(planning);

      const planned = await this.createPlan(planning, provider, controller.signal);
      const criteria = provider.deriveCriteria
        ? await provider.deriveCriteria({ task: planned, signal: controller.signal }).catch(() => deriveAcceptanceCriteria(planned))
        : deriveAcceptanceCriteria(planned);
      const withCriteria = {
        ...planned,
        acceptanceCriteria: criteria,
        updatedAt: nowIso()
      };
      await this.options.storage.upsertTask(withCriteria);
      await this.record(task.id, "task.plan_created", {
        summary: withCriteria.plan?.summary,
        stepCount: withCriteria.plan?.steps.length ?? 0
      });
      await this.record(task.id, "task.criteria_created", {
        count: withCriteria.acceptanceCriteria.length,
        criteria: withCriteria.acceptanceCriteria
      });

      await this.runSteps(withCriteria);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const failed = this.withStatus(task, "failed", {
        lastError: error instanceof Error ? error.message : String(error),
        finishedAt: nowIso()
      });
      await this.options.storage.upsertTask(failed);
      this.releaseAgentForTask(task.id);
      await this.persistReflection(failed, undefined, [failed.lastError ?? "task failed during planning"]);
      await this.record(task.id, "task.failed", { error: failed.lastError });
      void this.tick();
    } finally {
      this.abortControllers.delete(task.id);
    }
  }

  private async collectWorkspaceSnapshot(task: Task): Promise<Task> {
    try {
      // Only collect snapshot if workspace directory actually exists
      const { existsSync } = await import("node:fs");
      if (!existsSync(task.workspaceId)) {
        return task;
      }
      const explorer = new WorkspaceTools({ workspaceRoot: task.workspaceId });
      const dirEvidence = await explorer.execute(task.id, undefined, {
        name: "listFiles",
        input: { path: "." }
      });
      await this.record(task.id, "task.workspace_snapshot", { summary: dirEvidence.summary });
      return {
        ...task,
        evidence: [...(task.evidence ?? []), dirEvidence],
        updatedAt: nowIso()
      };
    } catch {
      return task;
    }
  }

  private async createPlan(task: Task, provider: ProviderAdapter, signal: AbortSignal): Promise<Task> {
    try {
      const relatedReflections = await this.relatedReflections(task);
      if (relatedReflections.length) {
        await this.record(task.id, "reflection.loaded", {
          count: relatedReflections.length,
          reflectionIds: relatedReflections.map((reflection) => reflection.id)
        });
      }
      const result = await provider.plan({ task, signal, relatedReflections });
      const plan = {
        createdAt: nowIso(),
        summary: result.summary,
        steps: result.steps.slice(0, 6).map((step, index) => ({
          id: createId("step"),
          index: index + 1,
          title: step.title,
          detail: step.detail,
          status: "planned" as const
        }))
      };
      return {
        ...task,
        plan,
        taskGraph: taskGraphFromPlan(plan, { resourceLocks: task.resourceLocks }),
        updatedAt: nowIso()
      };
    } catch (error) {
      const plan = this.createFallbackPlan();
      await this.record(task.id, "task.plan_fallback", { error: error instanceof Error ? error.message : String(error) });
      return { ...task, plan, taskGraph: taskGraphFromPlan(plan, { resourceLocks: task.resourceLocks }), updatedAt: nowIso() };
    }
  }

  private createFallbackPlan(): TaskPlan {
    return {
      createdAt: nowIso(),
      summary: "Fallback execution plan",
      steps: ["Understand task", "Execute task", "Summarize result"].map((title, index) => ({
        id: createId("step"),
        index: index + 1,
        title,
        status: "planned"
      }))
    };
  }

  private async runSteps(task: Task): Promise<void> {
    const provider = this.options.providers.find((item) => `agent_${item.id}` === task.agentId) ?? this.options.providers[0];
    const controller = this.abortControllers.get(task.id) ?? new AbortController();
    this.abortControllers.set(task.id, controller);
    this.setAgent(task.agentId, { status: "running", taskId: task.id });

    const plan = task.plan ?? this.createFallbackPlan();
    let current = this.withStatus(
      { ...task, plan, taskGraph: task.taskGraph ?? taskGraphFromPlan(plan, { resourceLocks: task.resourceLocks }) },
      "running",
      { startedAt: task.startedAt ?? nowIso() }
    );
    current = await this.ensureRunningAttempt(current);
    await this.options.storage.upsertTask(current);
    await this.record(task.id, "task.running", { providerId: provider.id, model: provider.model, stepCount: plan.steps.length });
    await this.record(task.id, "task.graph_ready", { nodeCount: current.taskGraph?.nodes.length ?? 0 });
    const policy = normalizeIterationPolicy(current.iterationPolicy);

    for (const step of current.plan?.steps ?? []) {
      if (step.status === "completed" || step.status === "skipped") {
        continue;
      }
      current = await this.markStep(current, step.id, "running", { startedAt: nowIso() });
      await this.record(task.id, "task.step_started", { stepId: step.id, index: step.index, title: step.title });

      try {
        let finalSummary = "";
        const seenToolBatches = new Set<string>();
        for (let iteration = 0; iteration < policy.maxToolIterationsPerStep; iteration += 1) {
          const runningStep = current.plan!.steps.find((item) => item.id === step.id)!;
          const completedSteps = current.plan!.steps.filter((item) => item.status === "completed");
          const result = await provider.runStep({ task: current, step: runningStep, completedSteps, signal: controller.signal });
          finalSummary = result.summary;
          await this.record(task.id, "provider.output", {
            stepId: step.id,
            iteration,
            summary: result.summary,
            rawOutput: result.rawOutput,
            toolCalls: result.toolCalls ?? []
          });

          if (result.needsUserInput) {
            const request: UserInputRequest = {
              ...result.needsUserInput,
              id: createId("input"),
              createdAt: nowIso()
            };
            const waiting = this.withStatus(current, "waiting_user", { userInputRequest: request });
            await this.options.storage.upsertTask(waiting);
            this.setAgent(task.agentId, { status: "waiting_user", taskId: task.id });
            await this.record(task.id, "agent.waiting_user", { stepId: step.id, question: request.question });
            await this.persistReflection(waiting, undefined, ["waiting for user input"]);
            return;
          }

          if (!result.toolCalls?.length) {
            break;
          }
          const signature = toolCallSignature(result.toolCalls);
          if (seenToolBatches.has(signature)) {
            await this.record(task.id, "tool.loop_stopped", { stepId: step.id, reason: "repeated_tool_calls" });
            break;
          }
          seenToolBatches.add(signature);
          current = await this.executeToolCalls(current, step.id, result.toolCalls);
        }

        current = await this.validateArtifactsAfterStep(current, step.id);

        const toolSummary = this.summarizeStepEvidence(current, step.id);
        current = await this.markStep(current, step.id, "completed", {
          completedAt: nowIso(),
          outputSummary: toolSummary ? `${finalSummary}\n\n${toolSummary}` : finalSummary
        });
        await this.record(task.id, "task.step_completed", { stepId: step.id, index: step.index, title: step.title });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if ((current.evaluationAttempts ?? 0) > 0 || current.result) {
          const review = this.withStatus(current, "review_required", {
            lastError: `Provider failed while revising the task: ${error instanceof Error ? error.message : String(error)}`,
            finishedAt: nowIso(),
            currentStepId: step.id
          });
          await this.options.storage.upsertTask(review);
          this.releaseAgentForTask(task.id);
          await this.persistReflection(review, undefined, [review.lastError ?? "revision provider failed"]);
          await this.record(task.id, "task.revision_provider_failed", { stepId: step.id, error: review.lastError });
          await this.record(task.id, "task.finished", { status: review.status, error: review.lastError });
          void this.tick();
          return;
        }
        current = await this.markStep(current, step.id, "failed", {
          completedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error)
        });
        const failed = this.withStatus(current, "failed", {
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
          currentStepId: step.id
        });
        await this.options.storage.upsertTask(failed);
        this.releaseAgentForTask(task.id);
        await this.persistReflection(failed, undefined, [failed.lastError ?? "step failed"]);
        await this.record(task.id, "task.step_failed", { stepId: step.id, error: failed.lastError });
        await this.record(task.id, "task.failed", { error: failed.lastError });
        void this.tick();
        return;
      }
    }

    const result = this.createResult(current);
    current = { ...current, result, updatedAt: nowIso() };
    await this.options.storage.upsertTask(current);
    await this.record(task.id, "task.result_created", {
      revision: result.revision,
      summary: result.summary,
      sourceStepIds: result.sourceStepIds
    });

    const runSummary = this.createRunSummary(current);
    const judging = this.withStatus(current, "judging", { currentStepId: undefined });
    await this.options.storage.upsertTask(judging);
    await this.record(task.id, "task.judging", {});
    await this.record(task.id, "judge.started", { revision: result.revision });

    const deterministicResult = runDeterministicChecks(judging, judging.evidence ?? []);
    await this.record(task.id, "judge.deterministic_checks", {
      allPassed: deterministicResult.allPassed,
      hasFailures: deterministicResult.hasFailures,
      checks: deterministicResult.checks
    });

    const attempts = judging.evaluationAttempts ?? 0;
    let evaluation = await this.evaluateTaskWithFallback(provider, judging, result, runSummary, controller.signal);

    const criteriaVerdict = evaluation.criteriaResults?.length ? computeVerdictFromCriteria(evaluation.criteriaResults) : undefined;
    evaluation = applyCanonicalVerdict(
      evaluation,
      {
        llmJudgeVerdict: evaluation.verdict,
        deterministicCheckVerdict: deterministicVerdictFromChecks(deterministicResult),
        criteriaVerdict
      },
      {
        deterministicChecks: deterministicResult.checks,
        criteriaResults: evaluation.criteriaResults
      }
    );
    const attemptCount = attempts + 1;
    const ledger = updateProgressLedger(judging.progressLedger, evaluation, {
      deterministicChecks: deterministicResult.checks,
      criteriaResults: evaluation.criteriaResults,
      evidence: judging.evidence,
      policy,
      attempts: attemptCount
    });
    const finalizedAttempts = this.finishCurrentAttempt(judging, evaluation, ledger);
    const judged: Task = { ...judging, progressLedger: ledger, attempts: finalizedAttempts, evaluationAttempts: attemptCount, updatedAt: nowIso() };

    await this.options.storage.upsertEvaluation(evaluation);
    await this.options.storage.upsertTask(judged);
    await this.record(task.id, "judge.completed", {
      verdict: evaluation.verdict,
      overallVerdict: evaluation.overallVerdict,
      confidence: evaluation.confidence,
      revision: evaluation.revision,
      deterministicPassed: deterministicResult.allPassed
    });
    await this.record(task.id, "progress.updated", {
      score: ledger.score,
      stagnationCount: ledger.stagnationCount,
      passedChecks: ledger.passedChecks.length,
      failedChecks: ledger.failedChecks.length,
      blockers: ledger.blockers.length
    });

    const decision = decideNextIteration(policy, ledger, evaluation, attemptCount);
    await this.record(task.id, "iteration.decision", decision);

    if (decision.action === "continue") {
      const revised = this.revisePlanAfterEvaluation(judged, evaluation, attemptCount);
      await this.options.storage.upsertTask(revised);
      await this.record(task.id, "task.plan_revised", {
        revision: result.revision + 1,
        stepCount: revised.plan?.steps.length ?? 0,
        suggestedNextSteps: evaluation.suggestedNextSteps ?? [],
        hypothesis: decision.nextHypothesis?.summary
      });
      await this.runSteps(revised);
      return;
    }

    const finalStatus = decision.action === "complete" ? "completed" : decision.action === "failed" ? "failed" : "review_required";
    const finalTask = this.withStatus(judged, finalStatus, { finishedAt: nowIso() });
    await this.options.storage.upsertTask(finalTask);
    this.releaseAgentForTask(task.id);
    await this.persistReflection(finalTask, evaluation);
    await this.record(task.id, "task.finished", { status: finalTask.status });
    void this.tick();
  }

  private async evaluateTaskWithFallback(
    provider: ProviderAdapter,
    task: Task,
    result: TaskResult,
    runSummary: string,
    signal: AbortSignal
  ) {
    try {
      const judgeResult = await provider.judge({
        task,
        result,
        runSummary,
        diffSummary: this.latestEvidenceOutput(task, "gitDiff"),
        testResults: this.latestEvidenceOutput(task, "runTests"),
        policyEvents: this.policyEvidenceSummary(task),
        acceptanceCriteria: task.acceptanceCriteria,
        evidence: task.evidence,
        signal
      });
      return evaluationFromJudgeResult(task.id, judgeResult, result.revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.record(task.id, "judge.provider_failed", { revision: result.revision, error: message });
      const fallback = runHeuristicJudge({
        task,
        runSummary,
        testResults: this.latestEvidenceOutput(task, "runTests"),
        policyEvents: this.policyEvidenceSummary(task),
        evidence: task.evidence
      });
      return {
        ...fallback,
        revision: result.revision,
        findings: [...fallback.findings, `LLM judge failed: ${message}`],
        rationale: `LLM judge failed, so Flint used local evidence-based evaluation. ${fallback.rationale ?? ""}`.trim()
      };
    }
  }

  private createResult(task: Task): TaskResult {
    const completedSteps = task.plan?.steps.filter((step) => step.status === "completed") ?? [];
    const evidence = task.evidence ?? [];
    const diffEvidence = evidence.filter((item) => item.toolName === "gitDiff" && item.status === "succeeded");
    const testEvidence = evidence.filter((item) => item.toolName === "runTests");
    const revision = (task.result?.revision ?? 0) + 1;
    const summary =
      diffEvidence.at(-1)?.summary ??
      completedSteps.at(-1)?.outputSummary ??
      completedSteps.map((step) => step.outputSummary).find((summaryText): summaryText is string => Boolean(summaryText)) ??
      "Task execution produced no step summary.";
    const content = [
      `# ${task.title}`,
      "",
      `**Revision:** ${revision}`,
      "",
      "## Summary",
      "",
      summary,
      "",
      "## Step Results",
      "",
      ...(completedSteps.length
        ? completedSteps.flatMap((step) => [
            `### ${step.index}. ${step.title}`,
            "",
            step.outputSummary ?? "Completed.",
            ""
          ])
        : ["No completed steps yet.", ""]),
      "## Evidence / Execution Diagnostics",
      "",
      ...(evidence.length
        ? evidence.flatMap((item) => [formatEvidenceLine(item)])
        : ["No tool evidence recorded."]),
      "",
      "## Diff",
      "",
      diffEvidence.at(-1)?.output ? `\`\`\`diff\n${diffEvidence.at(-1)?.output}\n\`\`\`` : "No diff captured.",
      "",
      "## Tests",
      "",
      testEvidence.at(-1)?.output ? `\`\`\`\n${testEvidence.at(-1)?.output}\n\`\`\`` : "No test output captured."
    ].join("\n");
    return {
      format: "markdown",
      content,
      summary,
      createdAt: nowIso(),
      sourceStepIds: completedSteps.map((step) => step.id),
      sourceEvidenceIds: evidence.map((item) => item.id),
      revision
    };
  }

  private createRunSummary(task: Task): string {
    const stepSummary =
      task.plan?.steps
        .map((step) => `${step.index}. ${step.title}: ${step.outputSummary ?? step.error ?? step.status}`)
        .join("\n") ?? "No step summary available.";
    const evidenceSummary = task.evidence?.map((item) => formatEvidenceLine(item)).join("\n");
    return [stepSummary, evidenceSummary ? `Evidence:\n${evidenceSummary}` : undefined].filter(Boolean).join("\n\n");
  }

  private async executeToolCalls(task: Task, stepId: string, toolCalls: WorkspaceToolCall[]): Promise<Task> {
    let current = task;
    const tools = new WorkspaceTools({
      workspaceRoot: task.workspaceId,
      allowFileWrites: true,
      allowTerminalCommands: true,
      testCommand: this.options.testCommand,
      diagnosticsResolver: this.options.diagnosticsResolver
    });
    for (const call of toolCalls.slice(0, 8)) {
      const permission = await this.resolveToolPermission(current, stepId, call);
      current = permission.task;
      if (!permission.allowed) {
        const evidence = this.createPolicyEvidence(current, stepId, call, permission.reason);
        current = await this.appendEvidence(current, evidence);
        await this.record(current.id, "tool.completed", {
          evidenceId: evidence.id,
          stepId,
          toolName: evidence.toolName,
          status: evidence.status,
          summary: evidence.summary
        });
        continue;
      }
      const evidence = await tools.execute(task.id, stepId, call);
      current = await this.appendEvidence(current, evidence);
      await this.record(task.id, "tool.completed", {
        evidenceId: evidence.id,
        stepId,
        toolName: evidence.toolName,
        status: evidence.status,
        summary: evidence.summary,
        path: evidence.path,
        command: evidence.command,
        outcome: evidence.outcome
      });
      if (evidence.outcome && evidence.outcome.semanticStatus !== "success" && evidence.outcome.semanticStatus !== "success_with_findings") {
        await this.record(task.id, "tool.recovery_available", {
          evidenceId: evidence.id,
          stepId,
          semanticStatus: evidence.outcome.semanticStatus,
          category: evidence.outcome.category,
          retryable: evidence.outcome.retryable,
          blocksCompletion: evidence.outcome.blocksCompletion,
          suggestedRecovery: evidence.outcome.suggestedRecovery ?? []
        });
      }
    }
    const diffEvidence = await tools.execute(task.id, stepId, { name: "gitDiff", input: {} });
    if (diffEvidence.status === "succeeded" && diffEvidence.output?.trim()) {
      current = await this.appendEvidence(current, diffEvidence);
      await this.record(task.id, "tool.completed", {
        evidenceId: diffEvidence.id,
        stepId,
        toolName: diffEvidence.toolName,
        status: diffEvidence.status,
        summary: diffEvidence.summary
      });
    }
    return current;
  }

  private async validateArtifactsAfterStep(task: Task, stepId: string): Promise<Task> {
    const tools = new WorkspaceTools({
      workspaceRoot: task.workspaceId,
      allowFileWrites: true,
      allowTerminalCommands: true,
      testCommand: this.options.testCommand,
      diagnosticsResolver: this.options.diagnosticsResolver
    });
    if (!(await tools.hasVerifiableArtifacts())) {
      return task;
    }
    const fingerprint = await tools.artifactFingerprint();
    if (fingerprint && (await this.latestArtifactValidationFingerprint(task.id)) === fingerprint) {
      await this.record(task.id, "artifact_validation.skipped_no_changes", { stepId, fingerprint });
      return task;
    }
    const permission = await this.resolveToolPermission(task, stepId, {
      name: "runTests",
      input: { command: "Flint automatic artifact validation" }
    });
    let current = permission.task;
    if (!permission.allowed) {
      await this.record(task.id, "artifact_validation.skipped", { stepId, reason: permission.reason });
      return current;
    }
    const deliverableEvidence = await tools.ensureRequestedDeliverables(task.id, stepId, task.prompt);
    for (const item of deliverableEvidence) {
      current = await this.appendEvidence(current, item);
      await this.record(task.id, "deliverable.completed", {
        evidenceId: item.id,
        stepId,
        toolName: item.toolName,
        status: item.status,
        summary: item.summary,
        path: item.path,
        command: item.command,
        outcome: item.outcome,
        fingerprint
      });
    }
    const evidence = await tools.validateArtifacts(task.id, stepId);
    for (const item of evidence) {
      current = await this.appendEvidence(current, item);
      await this.record(task.id, "artifact_validation.completed", {
        evidenceId: item.id,
        stepId,
        toolName: item.toolName,
        status: item.status,
        summary: item.summary,
        path: item.path,
        command: item.command,
        outcome: item.outcome,
        fingerprint
      });
    }
    return current;
  }

  private async latestArtifactValidationFingerprint(taskId: string): Promise<string | undefined> {
    const events = await this.options.storage.listEvents(taskId);
    return events
      .filter((event) => event.type === "artifact_validation.completed" || event.type === "artifact_validation.skipped_no_changes")
      .map((event) => event.payload.fingerprint)
      .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && fingerprint.length > 0)
      .at(-1);
  }

  private async resolveToolPermission(
    task: Task,
    stepId: string,
    call: WorkspaceToolCall
  ): Promise<{ allowed: boolean; task: Task; reason: string }> {
    const scope = permissionScopeForTool(call);
    if (!scope) {
      return { allowed: true, task, reason: "Read-only tool." };
    }
    if ((scope === "file_write" && this.options.allowFileWrites) || (scope === "terminal" && this.options.allowTerminalCommands)) {
      return { allowed: true, task, reason: "Allowed by global extension setting." };
    }

    const permissions = this.normalizePermissions(task.permissions);
    if (permissions.mode === "full_access" || permissions.grantedScopes.includes(scope)) {
      return { allowed: true, task: { ...task, permissions }, reason: "Allowed by task permissions." };
    }
    if (permissions.mode === "read_only") {
      return { allowed: false, task: { ...task, permissions }, reason: `Task is read-only; ${call.name} is not allowed.` };
    }
    if (!this.options.requestToolPermission) {
      return { allowed: false, task: { ...task, permissions }, reason: `Permission required for ${call.name}, but no approval handler is available.` };
    }

    const request: ToolPermissionRequest = {
      id: createId("perm"),
      taskId: task.id,
      stepId,
      scope,
      toolCall: call,
      reason: permissionReason(scope, call),
      createdAt: nowIso()
    };
    await this.record(task.id, "permission.requested", {
      requestId: request.id,
      stepId,
      scope,
      toolName: call.name,
      reason: request.reason,
      input: safeToolInput(call)
    });

    const decision = await this.options.requestToolPermission(request, task);
    if (decision === "denied") {
      await this.record(task.id, "permission.denied", { requestId: request.id, scope, toolName: call.name });
      return { allowed: false, task: { ...task, permissions }, reason: `User denied ${call.name}.` };
    }
    if (decision === "approved_for_task") {
      const updated = await this.grantTaskScope(task, scope);
      await this.record(task.id, "permission.approved", { requestId: request.id, decision, scope, toolName: call.name });
      return { allowed: true, task: updated, reason: "Approved for this task." };
    }
    if (decision === "full_access") {
      const updated = await this.updateTaskPermissions(task.id, "full_access");
      await this.record(task.id, "permission.approved", { requestId: request.id, decision, scope, toolName: call.name });
      return { allowed: true, task: updated, reason: "Task has full access." };
    }
    await this.record(task.id, "permission.approved", { requestId: request.id, decision, scope, toolName: call.name });
    return { allowed: true, task: { ...task, permissions }, reason: "Approved once." };
  }

  private async grantTaskScope(task: Task, scope: ToolPermissionScope): Promise<Task> {
    const permissions = this.normalizePermissions(task.permissions);
    const updated: Task = {
      ...task,
      permissions: {
        ...permissions,
        grantedScopes: Array.from(new Set([...permissions.grantedScopes, scope])),
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    };
    await this.options.storage.upsertTask(updated);
    return updated;
  }

  private createPolicyEvidence(task: Task, stepId: string, call: WorkspaceToolCall, reason: string): TaskEvidence {
    return {
      id: createId("evd"),
      taskId: task.id,
      stepId,
      toolName: "policy",
      status: "denied",
      summary: reason,
      timestamp: nowIso(),
      path: typeof call.input.path === "string" ? call.input.path : undefined,
      command: typeof call.input.command === "string" ? call.input.command : undefined
    };
  }

  private createTaskPermissions(mode: TaskPermissionMode, grantedScopes: ToolPermissionScope[] = []): TaskPermissions {
    return {
      mode,
      grantedScopes: mode === "full_access" ? ["file_write", "terminal"] : grantedScopes,
      updatedAt: nowIso()
    };
  }

  private normalizePermissions(permissions: TaskPermissions | undefined): TaskPermissions {
    if (!permissions) {
      return this.createTaskPermissions(this.options.defaultPermissionMode ?? "ask");
    }
    return {
      mode: permissions.mode,
      grantedScopes: permissions.grantedScopes ?? [],
      updatedAt: permissions.updatedAt ?? nowIso()
    };
  }

  private async appendEvidence(task: Task, evidence: TaskEvidence): Promise<Task> {
    const updated = {
      ...task,
      evidence: [...(task.evidence ?? []), evidence],
      updatedAt: nowIso()
    };
    await this.options.storage.upsertTask(updated);
    return updated;
  }

  private summarizeStepEvidence(task: Task, stepId: string): string | undefined {
    const evidence = task.evidence?.filter((item) => item.stepId === stepId) ?? [];
    if (!evidence.length) {
      return undefined;
    }
    return evidence.map((item) => `- ${item.status} ${item.toolName}: ${item.summary}`).join("\n");
  }

  private latestEvidenceOutput(task: Task, toolName: TaskEvidence["toolName"]): string | undefined {
    return task.evidence?.filter((item) => item.toolName === toolName && item.output).at(-1)?.output;
  }

  private policyEvidenceSummary(task: Task): string | undefined {
    const evidence = task.evidence?.filter((item) => item.status === "denied" || item.toolName === "policy") ?? [];
    return evidence.length ? evidence.map((item) => `${item.id}: ${item.summary}`).join("\n") : undefined;
  }

  private revisePlanAfterEvaluation(
    task: Task,
    evaluation: Evaluation,
    evaluationAttempts: number
  ): Task {
    const plan = task.plan ?? this.createFallbackPlan();
    const nextSteps = evaluation.suggestedNextSteps?.length
      ? evaluation.suggestedNextSteps
      : evaluationRepairSteps(evaluation);
    const startIndex = plan.steps.length;
    const revisedPlan: TaskPlan = {
      ...plan,
      summary: `${plan.summary}\n\nRevision ${evaluationAttempts + 1}: address judge findings.`,
      steps: [
        ...plan.steps,
        ...nextSteps.slice(0, 4).map((step, index) => ({
          id: createId("step"),
          index: startIndex + index + 1,
          title: step.title,
          detail: step.detail,
          status: "planned" as const
        }))
      ]
    };
    return {
      ...task,
      status: "running",
      currentStepId: undefined,
      evaluationAttempts,
      plan: revisedPlan,
      taskGraph: taskGraphFromPlan(revisedPlan, { resourceLocks: task.resourceLocks }),
      updatedAt: nowIso()
    };
  }

  private async ensureRunningAttempt(task: Task): Promise<Task> {
    const running = task.attempts?.some((attempt) => attempt.status === "running");
    if (running) {
      return task;
    }
    const revision = (task.result?.revision ?? 0) + 1;
    const attempt = startAttempt(task.id, `revision_${revision}: ${task.plan?.summary ?? "Execute task"}`);
    const updated = { ...task, attempts: [...(task.attempts ?? []), attempt], updatedAt: nowIso() };
    await this.options.storage.upsertTask(updated);
    await this.record(task.id, "attempt.started", { attemptId: attempt.id, strategy: attempt.strategy });
    return updated;
  }

  private finishCurrentAttempt(task: Task, evaluation: Evaluation, ledger: ProgressLedger) {
    const attempts = task.attempts ?? [];
    let index = -1;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      if (attempts[attemptIndex].status === "running") {
        index = attemptIndex;
        break;
      }
    }
    if (index < 0) {
      return attempts;
    }
    const latestDiff = task.evidence?.filter((item) => item.toolName === "gitDiff" && item.output?.trim()).at(-1);
    const verificationResults = [...ledger.passedChecks, ...ledger.failedChecks].slice(-12);
    const finished = finishAttempt(attempts[index], {
      status: evaluation.overallVerdict === "pass" ? "completed" : "failed",
      patchSummary: latestDiff?.summary ?? task.result?.summary,
      verificationResults,
      score: ledger.score
    });
    return attempts.map((attempt, attemptIndex) => (attemptIndex === index ? finished : attempt));
  }

  private async relatedReflections(task: Task): Promise<Reflection[]> {
    return this.options.storage.listReflections({
      taskType: taskTypeFor(task),
      projectFingerprint: projectFingerprintFor(task),
      limit: 3
    });
  }

  private async persistReflection(task: Task, evaluation?: Evaluation, failureModes: string[] = []): Promise<void> {
    const evidence = task.evidence ?? [];
    const reflection: Reflection = {
      id: createId("reflection"),
      taskType: taskTypeFor(task),
      projectFingerprint: projectFingerprintFor(task),
      failureModes: [
        ...failureModes,
        ...(evaluation?.findings ?? []),
        ...(task.progressLedger?.blockers.map((blocker) => blocker.summary) ?? [])
      ].slice(0, 12),
      successfulStrategy: task.status === "completed" ? task.attempts?.at(-1)?.strategy : undefined,
      commandsDiscovered: Array.from(new Set(evidence.map((item) => item.command).filter((command): command is string => Boolean(command)))).slice(0, 12),
      filesTouched: Array.from(new Set(evidence.map((item) => item.path).filter((path): path is string => Boolean(path)))).slice(0, 20),
      avoidNextTime: task.status === "completed" ? [] : ["Do not mark the task complete without canonical verdict and deterministic evidence."],
      createdAt: Date.now()
    };
    await this.options.storage.appendReflection(reflection);
    await this.record(task.id, "reflection.created", {
      reflectionId: reflection.id,
      taskType: reflection.taskType,
      failureModeCount: reflection.failureModes.length
    });
  }

  private async markStep(
    task: Task,
    stepId: string,
    status: TaskPlanStep["status"],
    patch: Partial<TaskPlanStep> = {}
  ): Promise<Task> {
    const plan = task.plan ?? this.createFallbackPlan();
    const updated: Task = {
      ...task,
      currentStepId: status === "running" ? stepId : task.currentStepId === stepId ? undefined : task.currentStepId,
      plan: {
        ...plan,
        steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...patch, status } : step))
      },
      updatedAt: nowIso()
    };
    await this.options.storage.upsertTask(updated);
    return updated;
  }

  private async record(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const event: TaskEvent = { id: createId("evt"), taskId, type, payload, timestamp: nowIso() };
    await this.options.storage.appendEvent(event);
    this.handlers.get(taskId)?.forEach((handler) => handler(event));
    this.handlers.get("all")?.forEach((handler) => handler(event));
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.options.storage.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return task;
  }

  private withStatus(task: Task, status: Task["status"], patch: Partial<Task> = {}): Task {
    return { ...task, ...patch, status, updatedAt: nowIso() };
  }

  private setAgent(agentId: string | undefined, patch: Partial<Agent>): void {
    if (!agentId) {
      return;
    }
    this.agents = this.agents.map((agent) => (agent.id === agentId ? { ...agent, ...patch } : agent));
  }

  private releaseAgentForTask(taskId: string): void {
    this.agents = this.agents.map((agent) =>
      agent.taskId === taskId ? { ...agent, status: "idle", taskId: undefined, leaseUntil: undefined } : agent
    );
  }
}

function permissionScopeForTool(call: WorkspaceToolCall): ToolPermissionScope | undefined {
  if (call.name === "writeFile" || call.name === "applyPatch") {
    return "file_write";
  }
  if (call.name === "runCommand" || call.name === "runTests" || call.name === "environmentCheck") {
    return "terminal";
  }
  return undefined;
}

function toolCallSignature(calls: WorkspaceToolCall[]): string {
  return JSON.stringify(calls.map((call) => ({ name: call.name, input: call.input })));
}

function permissionReason(scope: ToolPermissionScope, call: WorkspaceToolCall): string {
  if (scope === "file_write") {
    const path = typeof call.input.path === "string" ? ` ${call.input.path}` : "";
    return `${call.name} wants to modify workspace files${path}.`;
  }
  const command = typeof call.input.command === "string" ? `: ${call.input.command}` : ".";
  return `${call.name} wants to run a terminal command${command}`;
}

function formatEvidenceLine(item: TaskEvidence): string {
  const outcome = item.outcome;
  const status = outcome?.semanticStatus ?? item.status;
  const blocking = outcome?.blocksCompletion ? " · blocks completion" : "";
  const command = item.command ? ` \`${item.command}\`` : "";
  const path = item.path ? ` (${item.path})` : "";
  const artifacts = outcome?.artifacts?.length ? ` Artifacts: ${outcome.artifacts.map((artifact) => artifact.path).join(", ")}.` : "";
  const recovery = outcome?.suggestedRecovery?.length ? ` Recovery: ${outcome.suggestedRecovery.join("; ")}` : "";
  return `- **${status}** ${item.toolName}: ${outcome?.summary ?? item.summary}${blocking}${path}${command}.${artifacts}${recovery}`;
}

function evaluationRepairSteps(evaluation: Evaluation): TaskPlanStepSuggestion[] {
  const evidenceText = [...(evaluation.missingEvidence ?? []), ...evaluation.findings].join("\n").toLowerCase();
  const steps: TaskPlanStepSuggestion[] = [];
  if (/test|unittest|pytest/u.test(evidenceText)) {
    steps.push({
      title: "Create and run unit tests",
      detail: "Create the missing unittest test file for the current implementation, run it, and record the test output as evidence."
    });
  }
  if (/pylint|lint/u.test(evidenceText)) {
    steps.push({
      title: "Generate pylint report",
      detail: "Run pylint on the implementation and test files, save the output to a pylint report file, and keep non-fatal findings as quality evidence."
    });
  }
  if (/profile|performance/u.test(evidenceText)) {
    steps.push({
      title: "Generate performance profile",
      detail: "Create or run a profiling script, save the profiling output to a report file, and cite it in the result."
    });
  }
  if (/latex|report\\.tex|pdf|report/u.test(evidenceText)) {
    steps.push({
      title: "Create and compile LaTeX report",
      detail: "Write report.tex summarizing algorithm, tests, lint, and profiling evidence, then compile it to report.pdf."
    });
  }
  if (!steps.length) {
    steps.push({
      title: "Address evaluation findings",
      detail: [
        "Revise the result based on the latest evaluation.",
        evaluation.missingEvidence?.length ? `Missing evidence: ${evaluation.missingEvidence.join("; ")}` : undefined,
        evaluation.findings.length ? `Findings: ${evaluation.findings.join("; ")}` : undefined
      ].filter(Boolean).join("\n")
    });
  }
  return steps.slice(0, 4);
}

function safeToolInput(call: WorkspaceToolCall): Record<string, unknown> {
  if (call.name === "writeFile") {
    return {
      path: call.input.path,
      contentBytes: typeof call.input.content === "string" ? call.input.content.length : undefined
    };
  }
  if (call.name === "applyPatch") {
    return {
      path: call.input.path,
      searchBytes: typeof call.input.search === "string" ? call.input.search.length : undefined,
      replaceBytes: typeof call.input.replace === "string" ? call.input.replace.length : undefined
    };
  }
  if (call.name === "runCommand" || call.name === "runTests" || call.name === "environmentCheck") {
    return { command: call.input.command };
  }
  return call.input;
}

function inferResourceLocks(prompt: string): ResourceLock[] {
  if (!/\b(write|patch|edit|implement|fix|update|create|delete|remove|modify|refactor)\b/i.test(prompt)) {
    return [];
  }
  const locks: ResourceLock[] = [];
  const pathPattern = /(?:`([^`]+\.[A-Za-z0-9]+)`|["']([^"']+\.[A-Za-z0-9]+)["'])/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(prompt))) {
    const path = match[1] ?? match[2];
    if (path && !path.startsWith("/") && !path.includes("..")) {
      locks.push({ type: "file", path, mode: "write" });
    }
  }
  return dedupeResourceLocks(locks);
}

function dedupeResourceLocks(locks: ResourceLock[]): ResourceLock[] {
  const byKey = new Map<string, ResourceLock>();
  for (const lock of locks) {
    byKey.set(`${lock.type}:${lock.path ?? ""}:${lock.mode}`, lock);
  }
  return Array.from(byKey.values());
}

function taskTypeFor(task: Task): string {
  const text = `${task.title}\n${task.prompt}`.toLowerCase();
  if (/test|lint|build|typecheck|compile/u.test(text)) {
    return "verification";
  }
  if (/readme|docs?|documentation|文档/u.test(text)) {
    return "documentation";
  }
  if (/fix|bug|error|failed|repair/u.test(text)) {
    return "bugfix";
  }
  if (/implement|add|create|feature|update|refactor/u.test(text)) {
    return "code-edit";
  }
  return "general";
}

function projectFingerprintFor(task: Task): string {
  return task.workspaceId;
}
