import type {
  AcceptanceCriteria,
  DeriveCriteriaRequest,
  JudgeRequest,
  JudgeResult,
  PlanRequest,
  PlanResult,
  ProviderAdapter,
  ProviderConfig,
  RunRequest,
  RunResult,
  SecretResolver,
  StepRunRequest,
  Task,
  WorkspaceToolCall
} from "@flint/core-types";
import { deriveAcceptanceCriteria } from "@flint/judge";
import { llmJudgePrompt, parseJudgeResult } from "@flint/judge";

interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatResult {
  content: string;
  toolCalls?: WorkspaceToolCall[];
}

const WORKSPACE_TOOL_SCHEMAS: OpenAIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "readFile",
      description: "Read the contents of a file",
      parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path" } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "listFiles",
      description: "List directory contents",
      parameters: { type: "object", properties: { path: { type: "string", description: "Directory path, defaults to ." } } }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents using ripgrep",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
    }
  },
  {
    type: "function",
    function: {
      name: "writeFile",
      description: "Create or overwrite a file",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "applyPatch",
      description: "Search and replace text in an existing file",
      parameters: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } }, required: ["path", "search", "replace"] }
    }
  },
  {
    type: "function",
    function: {
      name: "runCommand",
      description: "Execute a shell command in the workspace",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  },
  {
    type: "function",
    function: {
      name: "runTests",
      description: "Run the test command",
      parameters: { type: "object", properties: { command: { type: "string", description: "Optional test command override" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "environmentCheck",
      description: "Check whether local runtime tools are available",
      parameters: { type: "object", properties: { tools: { type: "array", items: { type: "string" } } } }
    }
  },
  {
    type: "function",
    function: {
      name: "gitDiff",
      description: "Capture current git diff",
      parameters: { type: "object", properties: {} }
    }
  }
];

export class MockProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly type = "mock";
  readonly model = "mock";

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async plan(request: PlanRequest): Promise<PlanResult> {
    return {
      summary: `Plan for ${request.task.title}`,
      rawOutput: "mock plan",
      steps: [
        { title: "Understand task", detail: "Read the task prompt and identify the target outcome." },
        { title: "Execute task", detail: "Run the requested work through the configured AI worker." },
        { title: "Summarize result", detail: "Produce a concise completion summary for judge review." }
      ]
    };
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (request.task.prompt.includes("[[ask]]") && !request.task.prompt.includes("User response:")) {
      return {
        summary: "The task needs user input before it can continue.",
        rawOutput: "waiting for user",
        needsUserInput: {
          question: "Please provide the missing decision for this task.",
          context: request.task.prompt,
          blocking: true
        }
      };
    }

    return {
      summary: `Simulated completion for: ${request.task.title}`,
      rawOutput: `Flint mock provider completed "${request.task.prompt}".`
    };
  }

  async runStep(request: StepRunRequest): Promise<RunResult> {
    if (request.task.prompt.includes("[[step-fail]]")) {
      throw new Error(`Mock step failed: ${request.step.title}`);
    }
    if (request.task.prompt.includes("[[ask]]") && !request.task.prompt.includes("User response:")) {
      return {
        summary: "The task needs user input before it can continue.",
        rawOutput: "waiting for user",
        needsUserInput: {
          question: "Please provide the missing decision for this task.",
          context: request.step.title,
          blocking: true
        }
      };
    }
    if (request.task.prompt.includes("[[tool-write]]")) {
      return {
        summary: "Requested a workspace file write.",
        rawOutput: "mock tool write",
        toolCalls: [
          {
            name: "writeFile",
            input: {
              path: "flint-tool-output.txt",
              content: `Generated by Flint for ${request.task.title}\n`
            }
          }
        ]
      };
    }
    if (request.task.prompt.includes("[[tool-python]]") && request.step.index === 1) {
      return {
        summary: "Requested Python artifact creation.",
        rawOutput: "mock python artifact",
        toolCalls: [
          {
            name: "writeFile",
            input: {
              path: "flint_artifact.py",
              content: "def main():\n    print('flint artifact ok')\n\nif __name__ == '__main__':\n    main()\n"
            }
          }
        ]
      };
    }
    if (request.task.prompt.includes("[[tool-patch]]")) {
      return {
        summary: "Requested a workspace patch.",
        rawOutput: "mock tool patch",
        toolCalls: [
          {
            name: "applyPatch",
            input: {
              path: "flint-tool-output.txt",
              search: "Generated by Flint",
              replace: "Patched by Flint"
            }
          }
        ]
      };
    }
    return {
      summary: `Completed step ${request.step.index}: ${request.step.title}`,
      rawOutput: `Mock completed step "${request.step.title}" for task "${request.task.title}".`
    };
  }

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    if (request.task.prompt.includes("[[judge-review]]")) {
      return mockJudgeResult(request, "review_required", "The task needs one more focused iteration.", [
        { title: "Address evaluation finding", detail: "Revise the result to satisfy the original task goal." }
      ]);
    }
    if (request.task.prompt.includes("[[judge-fail]]")) {
      return mockJudgeResult(request, "fail", "The task result does not satisfy the requested goal.", [
        { title: "Repair failed outcome", detail: "Resolve the failed result before requesting another evaluation." }
      ]);
    }
    const hasDeniedEvidence = request.evidence?.some((item) => item.status === "denied" || item.outcome?.blocksCompletion);
    if (hasDeniedEvidence) {
      return mockJudgeResult(request, "review_required", "Some required tool evidence was denied or failed.", [
        { title: "Collect missing evidence", detail: "Run the required workspace tools successfully." }
      ]);
    }
    return mockJudgeResult(request, "pass", "The mock result satisfies the task goal.");
  }

  async deriveCriteria(request: DeriveCriteriaRequest): Promise<AcceptanceCriteria[]> {
    return deriveAcceptanceCriteria(request.task);
  }
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id: string;
  readonly type = "openai-compatible";
  readonly model: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly secrets: SecretResolver
  ) {
    this.id = config.id;
    this.model = config.model;
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(this.config.baseUrl && this.config.model);
  }

  async plan(request: PlanRequest): Promise<PlanResult> {
    const result = await this.chat(
      request.signal,
      planningSystemPrompt(),
      `${formatTaskContext(request.task)}\n\nTask title: ${request.task.title}\nTask prompt: ${request.task.prompt}`
    );
    return parsePlanResult(result.content);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const result = await this.chat(
      request.signal,
      workerSystemPrompt(),
      `${formatTaskContext(request.task)}\n\nTask prompt: ${request.task.prompt}`,
      { tools: WORKSPACE_TOOL_SCHEMAS }
    );

    // If we got native tool calls, use them directly
    if (result.toolCalls?.length) {
      return {
        summary: result.content || `Completed ${request.task.title}`,
        rawOutput: result.content,
        toolCalls: result.toolCalls
      };
    }

    // Fallback: try parsing from text (for providers that don't support tools)
    return toRunResult(request.task.title, request.task.prompt, result.content);
  }

  async runStep(request: StepRunRequest): Promise<RunResult> {
    const completed = request.completedSteps.map((step) => `- ${step.title}: ${step.outputSummary ?? "completed"}`).join("\n");
    const result = await this.chat(
      request.signal,
      `${workerSystemPrompt()} Execute only the current step.`,
      `${formatTaskContext(request.task)}\n\nTask: ${request.task.prompt}\n\nCurrent step ${request.step.index}: ${request.step.title}\n${request.step.detail ?? ""}\n\nCompleted steps:\n${completed || "None"}`,
      { tools: WORKSPACE_TOOL_SCHEMAS }
    );

    // If we got native tool calls, use them directly
    if (result.toolCalls?.length) {
      return {
        summary: result.content || `Step ${request.step.index}: ${request.step.title}`,
        rawOutput: result.content,
        toolCalls: result.toolCalls
      };
    }

    // Fallback: try parsing from text (for providers that don't support tools)
    return toRunResult(request.task.title, request.task.prompt, result.content);
  }

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    const result = await this.chat(request.signal, llmJudgePrompt, formatJudgeRequest(request), { jsonMode: true });
    return parseJudgeResultOrFallback(result.content);
  }

  async deriveCriteria(request: DeriveCriteriaRequest): Promise<AcceptanceCriteria[]> {
    try {
      const result = await this.chat(
        request.signal,
        deriveCriteriaSystemPrompt,
        `Task title: ${request.task.title}\nTask prompt: ${request.task.prompt}`,
        { jsonMode: true }
      );
      return parseCriteriaResponse(result.content, request.task);
    } catch {
      return deriveAcceptanceCriteria(request.task);
    }
  }

  private async chat(signal: AbortSignal, system: string, user: string, options?: { jsonMode?: boolean; tools?: OpenAIToolDefinition[] }): Promise<ChatResult> {
    const apiKey = this.config.secretRef ? await this.secrets.get(this.config.secretRef) : undefined;
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: "system",
              content: system
            },
            { role: "user", content: user }
          ],
          temperature: 0.2,
          ...(options?.jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(options?.tools ? { tools: options.tools } : {})
        })
      });
    } catch (error) {
      throw new Error(`OpenAI-compatible provider request failed for ${this.config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw new Error(`OpenAI-compatible provider failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const rawToolCalls = data.choices?.[0]?.message?.tool_calls;

    if (rawToolCalls?.length) {
      const toolCalls: WorkspaceToolCall[] = rawToolCalls
        .map((tc) => {
          try {
            const input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            if (isWorkspaceToolName(tc.function.name)) {
              return { name: tc.function.name, input } as WorkspaceToolCall;
            }
            return undefined;
          } catch {
            return undefined;
          }
        })
        .filter((call): call is WorkspaceToolCall => Boolean(call));

      if (toolCalls.length) {
        return { content, toolCalls };
      }
    }

    return { content };
  }
}

export class OllamaProvider implements ProviderAdapter {
  readonly id: string;
  readonly type = "ollama";
  readonly model: string;

  constructor(private readonly config: ProviderConfig) {
    this.id = config.id;
    this.model = config.model;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async plan(request: PlanRequest): Promise<PlanResult> {
    const rawOutput = await this.generate(
      request.signal,
      `${planningSystemPrompt()}\n\n${formatTaskContext(request.task)}\n\nTask title: ${request.task.title}\nTask prompt: ${request.task.prompt}`
    );
    return parsePlanResult(rawOutput);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const rawOutput = await this.generate(
      request.signal,
      `${workerSystemPrompt()}\n\n${formatTaskContext(request.task)}\n\nTask: ${request.task.prompt}`
    );
    return toRunResult(request.task.title, request.task.prompt, rawOutput);
  }

  async runStep(request: StepRunRequest): Promise<RunResult> {
    const completed = request.completedSteps.map((step) => `- ${step.title}: ${step.outputSummary ?? "completed"}`).join("\n");
    const rawOutput = await this.generate(
      request.signal,
      `${workerSystemPrompt()} Execute only the current step.\n\n${formatTaskContext(request.task)}\n\nTask: ${request.task.prompt}\n\nCurrent step ${request.step.index}: ${request.step.title}\n${request.step.detail ?? ""}\n\nCompleted steps:\n${completed || "None"}`
    );
    return toRunResult(request.task.title, request.task.prompt, rawOutput);
  }

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    const rawOutput = await this.generate(request.signal, `${llmJudgePrompt}\n\n${formatJudgeRequest(request)}`);
    return parseJudgeResultOrFallback(rawOutput);
  }

  async deriveCriteria(request: DeriveCriteriaRequest): Promise<AcceptanceCriteria[]> {
    try {
      const rawOutput = await this.generate(
        request.signal,
        `${deriveCriteriaSystemPrompt}\n\nTask title: ${request.task.title}\nTask prompt: ${request.task.prompt}`
      );
      return parseCriteriaResponse(rawOutput, request.task);
    } catch {
      return deriveAcceptanceCriteria(request.task);
    }
  }

  private async generate(signal: AbortSignal, prompt: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          prompt
        })
      });
    } catch (error) {
      throw new Error(`Ollama provider request failed for ${this.config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw new Error(`Ollama provider failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { response?: string };
    return data.response ?? "";
  }
}

export function createProviderAdapter(config: ProviderConfig, secrets: SecretResolver): ProviderAdapter {
  if (config.type === "openai-compatible") {
    return new OpenAICompatibleProvider(config, secrets);
  }
  if (config.type === "ollama") {
    return new OllamaProvider(config);
  }
  return new MockProvider();
}

export function formatTaskContext(task: Task): string {
  const recentEvidence = task.evidence
    ?.slice(-12)
    .map((item) => {
      const output = item.output ? `\n  Output: ${item.output.slice(0, 1200)}` : "";
      const error = item.error ? `\n  Error: ${item.error}` : "";
      const outcome = item.outcome
        ? ` outcome=${item.outcome.semanticStatus}/${item.outcome.category}${item.outcome.blocksCompletion ? " blocksCompletion" : ""}`
        : "";
      const recovery = item.outcome?.suggestedRecovery?.length ? `\n  Recovery: ${item.outcome.suggestedRecovery.join("; ")}` : "";
      return `- ${item.id} [${item.status}] ${item.toolName}: ${item.summary}${outcome}${item.path ? ` (${item.path})` : ""}${item.command ? ` command=${item.command}` : ""}${error}${recovery}${output}`;
    })
    .join("\n");
  return [
    `Working directory: ${task.workspaceId}`,
    "Use this working directory for planning and execution.",
    "Do not ask the user which directory to use unless they explicitly request a different workspace.",
    recentEvidence ? `Recent tool evidence:\n${recentEvidence}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatJudgeRequest(request: JudgeRequest): string {
  const plan = request.task.plan?.steps
    .map((step) => `${step.index}. ${step.title} [${step.status}]\n${step.detail ?? ""}\nOutput: ${step.outputSummary ?? "none"}${step.error ? `\nError: ${step.error}` : ""}`)
    .join("\n\n");
  return [
    formatTaskContext(request.task),
    `Task title: ${request.task.title}`,
    `Task goal: ${request.task.prompt}`,
    `Result revision: ${request.result.revision}`,
    `Result summary: ${request.result.summary}`,
    `Result content:\n${request.result.content}`,
    `Acceptance criteria:\n${formatAcceptanceCriteria(request)}`,
    `Evidence:\n${formatEvidence(request)}`,
    `Run summary:\n${request.runSummary}`,
    `Plan and step evidence:\n${plan || "No plan evidence."}`,
    request.diffSummary ? `Diff summary:\n${request.diffSummary}` : undefined,
    request.testResults ? `Test results:\n${request.testResults}` : undefined,
    request.policyEvents ? `Policy events:\n${request.policyEvents}` : undefined
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatAcceptanceCriteria(request: JudgeRequest): string {
  if (!request.acceptanceCriteria?.length) {
    return "No explicit criteria were generated.";
  }
  return request.acceptanceCriteria
    .map((criteria) => `- ${criteria.id}: ${criteria.statement}\n  Verification: ${criteria.verificationMethod}\n  Required evidence: ${criteria.requiredEvidence.join(", ") || "not specified"}`)
    .join("\n");
}

function formatEvidence(request: JudgeRequest): string {
  if (!request.evidence?.length) {
    return "No tool evidence was recorded.";
  }
  return request.evidence
    .map((evidence) => {
      const outcome = evidence.outcome
        ? ` outcome=${evidence.outcome.semanticStatus}/${evidence.outcome.category}${evidence.outcome.blocksCompletion ? " blocksCompletion" : ""}`
        : "";
      const artifacts = evidence.outcome?.artifacts?.length
        ? `\n  Artifacts: ${evidence.outcome.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`).join(", ")}`
        : "";
      const findings = evidence.outcome?.findings?.length
        ? `\n  Findings: ${evidence.outcome.findings.slice(0, 8).map((finding) => `${finding.severity}:${finding.file ?? ""}${finding.line ? `:${finding.line}` : ""} ${finding.message}`).join(" | ")}`
        : "";
      const recovery = evidence.outcome?.suggestedRecovery?.length ? `\n  Recovery: ${evidence.outcome.suggestedRecovery.join("; ")}` : "";
      const output = evidence.output ? `\n  Output excerpt:\n${evidence.output.slice(0, 3000)}` : "";
      return `- ${evidence.id} [${evidence.status}] ${evidence.toolName}: ${evidence.summary}${outcome}${evidence.path ? ` (${evidence.path})` : ""}${evidence.command ? ` command=${evidence.command}` : ""}${artifacts}${findings}${recovery}${output}`;
    })
    .join("\n");
}

function planningSystemPrompt(): string {
  return [
    "You are Flint's planning agent.",
    "You are given the current workspace directory listing below.",
    "IMPORTANT: ALWAYS plan to read and understand existing files BEFORE making any changes.",
    "Your first step should ALWAYS be exploration: read key files and understand the project structure.",
    "Do not assume files or directories exist — base your plan on the workspace listing provided.",
    "Return strict JSON only: {\"summary\":\"...\",\"steps\":[{\"title\":\"...\",\"detail\":\"...\"}]}.",
    "Use 2 to 6 steps. The first step should involve reading relevant files."
  ].join(" ");
}

function workerSystemPrompt(): string {
  return [
    "You are a coding task worker inside Flint.",
    "IMPORTANT: Before writing or modifying any files, ALWAYS first explore the workspace:",
    "1. Use listFiles to see the directory structure.",
    "2. Use readFile to understand existing code.",
    "3. Only then proceed with changes based on what you found.",
    "Return either concise text, or strict JSON only: {\"summary\":\"...\",\"toolCalls\":[{\"name\":\"readFile|listFiles|grep|glob|writeFile|applyPatch|runCommand|runTests|environmentCheck|gitDiff\",\"input\":{...}}]}.",
    "Use paths relative to the current workspace unless an existing evidence path is already absolute inside the workspace.",
    "Tool input schemas:",
    "- readFile: {\"path\":\"relative/file\"}",
    "- listFiles: {\"path\":\".\"}",
    "- grep: {\"pattern\":\"text or regex\",\"path\":\".\"}",
    "- glob: {\"pattern\":\"**/*.ts\"}",
    "- writeFile: {\"path\":\"relative/file\",\"content\":\"full file content\"}",
    "- applyPatch: {\"path\":\"relative/file\",\"search\":\"exact existing text\",\"replace\":\"replacement text\"}",
    "- runCommand: {\"command\":\"shell command\"}",
    "- runTests: {\"command\":\"optional test command\"}",
    "- environmentCheck: {\"tools\":[\"python3\",\"pytest\",\"pdflatex\"]}",
    "Do not wrap commands in sh -lc/bash -lc and do not prefix commands with cd; Flint already runs commands in the working directory.",
    "Before running pdflatex, xelatex, lualatex, or latexmk, confirm the target .tex filename with listFiles/glob/readFile.",
    "Prefer listFiles or glob before reading a file if the exact filename is uncertain.",
    "A command exit code is diagnostic evidence, not an instruction to stop. If outcome is diagnostic_failure or retryable_failure, repair the input/files or run a different validation command.",
    "If outcome blocksCompletion is true, address the blocker or explain exactly why it cannot be resolved.",
    "If a tool failed in completed-step evidence, do not repeat the identical failing call; correct the path/input or explain the blocker with [[flint:ask]].",
    "Prefer applyPatch for edits to existing files and writeFile for new files."
  ].join(" ");
}

const deriveCriteriaSystemPrompt = `You are Flint's criteria generator. Given a task description, produce 2-5 measurable acceptance criteria.
Return strict JSON only: {"criteria":[{"statement":"...","verificationMethod":"...","requiredEvidence":["..."]}]}

Each criterion must have:
- statement: What must be true for the task to succeed (imperative form, e.g. "Fix the login bug", "Add unit tests")
- verificationMethod: How to verify - one of: "test_output" (run tests), "file_diff" (check file changes), "command_result" (run a command), "manual_review" (human check)
- requiredEvidence: Array of evidence types needed - from: "result", "diff", "test_output", "command_output"

Focus on what the user actually asked for. Do not add criteria about code quality, documentation, or communication unless explicitly requested.`;

function parseCriteriaResponse(rawOutput: string, task: Task): AcceptanceCriteria[] {
  const jsonText = extractJson(rawOutput);
  const parsed = JSON.parse(jsonText) as { criteria?: unknown[] };
  if (!Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
    return deriveAcceptanceCriteria(task);
  }
  const criteria: AcceptanceCriteria[] = [];
  for (const item of parsed.criteria) {
    const c = item as { statement?: unknown; verificationMethod?: unknown; requiredEvidence?: unknown };
    if (typeof c.statement !== "string" || !c.statement.trim()) {
      continue;
    }
    criteria.push({
      id: `ac_${criteria.length + 1}`,
      statement: c.statement.trim(),
      whyItMatters: "Derived from task prompt by LLM analysis.",
      verificationMethod: typeof c.verificationMethod === "string" ? c.verificationMethod : "manual_review",
      requiredEvidence: Array.isArray(c.requiredEvidence) ? c.requiredEvidence.filter((e): e is string => typeof e === "string") : ["result"]
    });
    if (criteria.length >= 5) {
      break;
    }
  }
  return criteria.length >= 2 ? criteria : deriveAcceptanceCriteria(task);
}

function parseJudgeResultOrFallback(rawOutput: string): JudgeResult {
  try {
    return parseJudgeResult(rawOutput);
  } catch (error) {
    return {
      verdict: "review_required",
      confidence: 0.45,
      scores: {
        completion: 0.5,
        correctness: 0.5,
        scopeControl: 0.5,
        safety: 0.5,
        quality: 0.5,
        communication: 0.5
      },
      findings: [error instanceof Error ? error.message : "Judge output could not be parsed."],
      evidenceRefs: ["judge_parse_fallback"],
      rationale: "The judge response was not valid JSON, so Flint requires review instead of marking the task complete.",
      suggestedNextSteps: [{ title: "Re-run evaluation", detail: "Produce a valid judge result for the current task outcome." }],
      rawOutput
    };
  }
}

function mockJudgeResult(
  request: JudgeRequest,
  verdict: JudgeResult["verdict"],
  rationale: string,
  suggestedNextSteps?: JudgeResult["suggestedNextSteps"]
): JudgeResult {
  const criteriaResults = request.acceptanceCriteria?.map((criteria) => ({
    criteriaId: criteria.id,
    statement: criteria.statement,
    status: verdict === "pass" ? ("pass" as const) : ("unknown" as const),
    rationale: verdict === "pass" ? "Satisfied by mock execution evidence." : rationale,
    evidenceRefs: request.evidence?.map((item) => item.id) ?? ["mock_result"],
    nextSteps: verdict === "pass" ? undefined : suggestedNextSteps?.map((step) => step.title)
  }));
  return {
    verdict,
    confidence: verdict === "pass" ? 0.9 : 0.68,
    scores: {
      completion: verdict === "pass" ? 0.92 : 0.45,
      correctness: verdict === "pass" ? 0.9 : 0.45,
      scopeControl: 0.9,
      safety: 0.92,
      quality: verdict === "pass" ? 0.88 : 0.5,
      communication: 0.86
    },
    findings: verdict === "pass" ? [] : [rationale],
    evidenceRefs: request.evidence?.map((item) => item.id) ?? ["mock_result"],
    rationale,
    suggestedNextSteps,
    criteriaResults,
    missingEvidence: verdict === "pass" ? [] : ["required tool evidence"],
    judgeRationale: rationale,
    rawOutput: "mock judge"
  };
}

function toRunResult(title: string, prompt: string, rawOutput: string): RunResult {
  const askMatch = rawOutput.match(/\[\[flint:ask\]\]\s*(.+)/is);
  if (askMatch) {
    return {
      summary: "The provider requested user input.",
      rawOutput,
      needsUserInput: {
        question: askMatch[1].trim(),
        context: prompt,
        blocking: true
      }
    };
  }

  const structured = parseRunResultJson(rawOutput);
  return {
    summary: structured?.summary ?? (rawOutput.trim() || `Completed ${title}`),
    rawOutput,
    toolCalls: structured?.toolCalls
  };
}

function parseRunResultJson(rawOutput: string): { summary?: string; toolCalls?: WorkspaceToolCall[] } | undefined {
  try {
    const parsed = JSON.parse(extractJson(rawOutput)) as { summary?: unknown; toolCalls?: unknown };
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? parsed.toolCalls
          .map((call) => {
            const item = call as { name?: unknown; input?: unknown };
            return typeof item.name === "string" && isWorkspaceToolName(item.name) && item.input && typeof item.input === "object"
              ? { name: item.name, input: item.input as Record<string, unknown> }
              : undefined;
          })
          .filter((call): call is WorkspaceToolCall => Boolean(call))
      : undefined;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      toolCalls
    };
  } catch {
    return undefined;
  }
}

function isWorkspaceToolName(name: string): name is WorkspaceToolCall["name"] {
  return ["glob", "grep", "readFile", "listFiles", "writeFile", "applyPatch", "runCommand", "environmentCheck", "getDiagnostics", "gitDiff", "runTests"].includes(name);
}

export function parsePlanResult(rawOutput: string): PlanResult {
  const jsonText = extractJson(rawOutput);
  const parsed = JSON.parse(jsonText) as {
    summary?: unknown;
    steps?: unknown;
  };
  if (typeof parsed.summary !== "string" || !Array.isArray(parsed.steps)) {
    throw new Error("Invalid plan schema");
  }
  const steps: Array<{ title: string; detail?: string }> = [];
  for (const step of parsed.steps) {
    if (!step || typeof step !== "object") {
      continue;
    }
    const item = step as { title?: unknown; detail?: unknown };
    if (typeof item.title !== "string" || item.title.trim().length === 0) {
      continue;
    }
    steps.push({
      title: item.title.trim(),
      detail: typeof item.detail === "string" ? item.detail.trim() : undefined
    });
    if (steps.length >= 6) {
      break;
    }
  }

  if (steps.length < 2) {
    throw new Error("Plan must contain at least 2 valid steps");
  }
  return {
    summary: parsed.summary.trim(),
    steps,
    rawOutput
  };
}

function extractJson(rawOutput: string): string {
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }
  const start = rawOutput.indexOf("{");
  const end = rawOutput.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return rawOutput.slice(start, end + 1);
  }
  return rawOutput;
}
