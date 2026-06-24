export type TaskStatus =
  | "queued"
  | "dispatching"
  | "planning"
  | "running"
  | "waiting_user"
  | "judging"
  | "review_required"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentStatus =
  | "idle"
  | "reserved"
  | "running"
  | "waiting_user"
  | "cooling_down"
  | "offline"
  | "disabled";

export type JudgeVerdict = "pass" | "review_required" | "fail";
export type ProviderType = "openai-compatible" | "ollama" | "mock";
export type TaskPriority = "P0" | "P1" | "P2" | "P3";
export type TaskStepStatus = "planned" | "running" | "completed" | "failed" | "skipped";
export type EvidenceStatus = "succeeded" | "failed" | "denied";
export type CommandSemanticStatus =
  | "success"
  | "success_with_findings"
  | "diagnostic_failure"
  | "retryable_failure"
  | "blocking_failure"
  | "environment_missing"
  | "permission_denied";
export type CommandOutcomeCategory = "test" | "lint" | "format" | "build" | "compile" | "script" | "environment" | "file" | "unknown";
export type CommandFindingSeverity = "info" | "warning" | "error" | "fatal";
export type CommandArtifactKind = "report" | "binary" | "log" | "coverage" | "profile" | "other";
export type CriteriaStatus = "pass" | "fail" | "unknown";
export type TaskPermissionMode = "ask" | "full_access" | "read_only";
export type ToolPermissionScope = "file_write" | "terminal";
export type ToolPermissionDecision = "approved_once" | "approved_for_task" | "full_access" | "denied";
export type ResourceLockType = "file" | "directory" | "workspace" | "terminal" | "git-worktree";
export type ResourceLockMode = "read" | "write";
export type NodeStatus = "planned" | "ready" | "running" | "completed" | "failed" | "skipped" | "blocked";
export type VerificationKind = "command" | "test" | "lint" | "typecheck" | "build" | "diff" | "diagnostic" | "manual";
export type CheckStatus = "pass" | "fail" | "unknown";
export type AttemptStatus = "planned" | "running" | "completed" | "failed" | "abandoned" | "selected";
export type WorkspaceToolName =
  | "glob"
  | "grep"
  | "readFile"
  | "listFiles"
  | "writeFile"
  | "applyPatch"
  | "runCommand"
  | "environmentCheck"
  | "getDiagnostics"
  | "gitDiff"
  | "runTests";

export interface TaskBudget {
  maxUsd?: number;
  maxTokens?: number;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: TaskPriority;
  workspaceId: string;
  agentId?: string;
  budget?: TaskBudget;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  userInputRequest?: UserInputRequest;
  plan?: TaskPlan;
  currentStepId?: string;
  result?: TaskResult;
  evaluationAttempts?: number;
  evidence?: TaskEvidence[];
  acceptanceCriteria?: AcceptanceCriteria[];
  permissions?: TaskPermissions;
  iterationPolicy?: IterationPolicy;
  progressLedger?: ProgressLedger;
  taskGraph?: TaskGraph;
  attempts?: Attempt[];
  resourceLocks?: ResourceLock[];
}

export interface TaskPlanStep {
  id: string;
  index: number;
  title: string;
  detail?: string;
  status: TaskStepStatus;
  startedAt?: string;
  completedAt?: string;
  outputSummary?: string;
  error?: string;
}

export interface TaskPlan {
  createdAt: string;
  summary: string;
  steps: TaskPlanStep[];
}

export interface ResourceLock {
  type: ResourceLockType;
  path?: string;
  mode: ResourceLockMode;
}

export interface VerificationSpec {
  kind: VerificationKind;
  command?: string;
  expectedEvidence?: string[];
  required: boolean;
}

export interface TaskGraphNode {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  status: NodeStatus;
  requiredEvidence: string[];
  allowedTools: WorkspaceToolName[];
  resourceLocks: ResourceLock[];
  verification: VerificationSpec[];
  sourceStepId?: string;
}

export interface TaskGraph {
  createdAt: string;
  summary: string;
  nodes: TaskGraphNode[];
}

export interface IterationPolicy {
  maxAttempts: number;
  maxToolIterationsPerStep: number;
  maxTotalToolCalls: number;
  maxRuntimeMs?: number;
  maxCostUsd?: number;
  stagnationWindow: number;
  minProgressDelta: number;
  allowBranching: boolean;
  requireHumanReviewOnRisk: boolean;
}

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  summary: string;
  evidenceRefs: string[];
  weight?: number;
}

export interface Finding {
  id: string;
  summary: string;
  source: "judge" | "deterministic" | "criteria" | "tool" | "human";
  severity: "info" | "warning" | "error" | "blocking";
  evidenceRefs: string[];
}

export interface Blocker {
  id: string;
  summary: string;
  source: "policy" | "tool" | "environment" | "budget" | "human" | "stagnation";
  recoverable: boolean;
  evidenceRefs: string[];
}

export interface Hypothesis {
  id: string;
  summary: string;
  confidence: number;
  nextStep?: string;
}

export interface ProgressLedger {
  score: number;
  scoreHistory: number[];
  passedChecks: CheckResult[];
  failedChecks: CheckResult[];
  fixedFindings: Finding[];
  openFindings: Finding[];
  blockers: Blocker[];
  currentHypotheses: Hypothesis[];
  stagnationCount: number;
  totalToolCalls: number;
  attempts: number;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  taskId: string;
  strategy: string;
  status: AttemptStatus;
  startedAt: number;
  finishedAt?: number;
  patchSummary?: string;
  verificationResults: CheckResult[];
  score?: number;
}

export interface Reflection {
  id: string;
  taskType: string;
  projectFingerprint: string;
  failureModes: string[];
  successfulStrategy?: string;
  commandsDiscovered: string[];
  filesTouched: string[];
  avoidNextTime: string[];
  createdAt: number;
}

export interface TaskResult {
  format: "markdown" | "text";
  content: string;
  summary: string;
  createdAt: string;
  sourceStepIds: string[];
  sourceEvidenceIds?: string[];
  revision: number;
}

export interface WorkspaceToolCall {
  id?: string;
  name: WorkspaceToolName;
  input: Record<string, unknown>;
}

export interface TaskPermissions {
  mode: TaskPermissionMode;
  grantedScopes: ToolPermissionScope[];
  updatedAt: string;
}

export interface ToolPermissionRequest {
  id: string;
  taskId: string;
  stepId?: string;
  scope: ToolPermissionScope;
  toolCall: WorkspaceToolCall;
  reason: string;
  createdAt: string;
}

export interface TaskEvidence {
  id: string;
  taskId: string;
  stepId?: string;
  toolName: WorkspaceToolName | "provider" | "judge" | "policy";
  status: EvidenceStatus;
  summary: string;
  timestamp: string;
  path?: string;
  command?: string;
  output?: string;
  error?: string;
  outcome?: CommandOutcome;
}

export interface CommandOutcome {
  exitCode?: number;
  semanticStatus: CommandSemanticStatus;
  category: CommandOutcomeCategory;
  retryable: boolean;
  blocksCompletion: boolean;
  summary: string;
  findings?: CommandFinding[];
  artifacts?: CommandArtifact[];
  suggestedRecovery?: string[];
}

export interface CommandFinding {
  severity: CommandFindingSeverity;
  message: string;
  file?: string;
  line?: number;
}

export interface CommandArtifact {
  path: string;
  kind: CommandArtifactKind;
}

export interface AcceptanceCriteria {
  id: string;
  statement: string;
  whyItMatters: string;
  verificationMethod: string;
  requiredEvidence: string[];
}

export interface CriteriaResult {
  criteriaId: string;
  statement: string;
  status: CriteriaStatus;
  rationale: string;
  evidenceRefs: string[];
  nextSteps?: string[];
}

export interface UserInputRequest {
  id: string;
  question: string;
  context?: string;
  options?: string[];
  blocking: boolean;
  createdAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface Agent {
  id: string;
  name: string;
  provider: string;
  model: string;
  status: AgentStatus;
  capabilities: string[];
  taskId?: string;
  leaseUntil?: string;
}

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
  secretRef?: string;
  enabled: boolean;
}

export interface EvaluationScores {
  completion: number;
  correctness: number;
  scopeControl: number;
  safety: number;
  quality: number;
  communication: number;
}

export interface Evaluation {
  id: string;
  taskId: string;
  verdict: JudgeVerdict;
  confidence: number;
  scores: EvaluationScores;
  findings: string[];
  evidenceRefs: string[];
  createdAt: string;
  rationale?: string;
  suggestedNextSteps?: Array<{
    title: string;
    detail?: string;
  }>;
  revision?: number;
  criteriaResults?: CriteriaResult[];
  overallVerdict?: JudgeVerdict;
  missingEvidence?: string[];
  nextSteps?: Array<{
    title: string;
    detail?: string;
  }>;
  judgeRationale?: string;
  deterministicChecks?: Array<{
    type: string;
    pass: boolean;
    detail: string;
  }>;
}

export interface TaskDetail {
  task: Task;
  events: TaskEvent[];
  evaluation?: Evaluation;
}

export interface CreateTaskInput {
  title: string;
  prompt: string;
  priority?: TaskPriority;
  workspaceId: string;
  permissionMode?: TaskPermissionMode;
  preferredAgentTags?: string[];
  budget?: TaskBudget;
  resourceLocks?: ResourceLock[];
  iterationPolicy?: Partial<IterationPolicy>;
}

export interface TaskFilter {
  statuses?: TaskStatus[];
  workspaceId?: string;
}

export interface RunRequest {
  task: Task;
  signal: AbortSignal;
}

export interface PlanRequest {
  task: Task;
  signal: AbortSignal;
  relatedReflections?: Reflection[];
}

export interface PlanResult {
  summary: string;
  steps: Array<{
    title: string;
    detail?: string;
  }>;
  rawOutput: string;
}

export interface StepRunRequest {
  task: Task;
  step: TaskPlanStep;
  completedSteps: TaskPlanStep[];
  signal: AbortSignal;
}

export interface JudgeRequest {
  task: Task;
  result: TaskResult;
  runSummary: string;
  diffSummary?: string;
  testResults?: string;
  policyEvents?: string;
  acceptanceCriteria?: AcceptanceCriteria[];
  evidence?: TaskEvidence[];
  signal: AbortSignal;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  confidence: number;
  scores: EvaluationScores;
  findings: string[];
  evidenceRefs: string[];
  rawOutput: string;
  rationale?: string;
  suggestedNextSteps?: Array<{
    title: string;
    detail?: string;
  }>;
  criteriaResults?: CriteriaResult[];
  missingEvidence?: string[];
  judgeRationale?: string;
}

export interface RunResult {
  summary: string;
  rawOutput: string;
  needsUserInput?: Omit<UserInputRequest, "id" | "createdAt">;
  toolCalls?: WorkspaceToolCall[];
}

export interface DeriveCriteriaRequest {
  task: Task;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  id: string;
  type: ProviderType;
  model: string;
  healthCheck(): Promise<boolean>;
  plan(request: PlanRequest): Promise<PlanResult>;
  run(request: RunRequest): Promise<RunResult>;
  runStep(request: StepRunRequest): Promise<RunResult>;
  judge(request: JudgeRequest): Promise<JudgeResult>;
  deriveCriteria?(request: DeriveCriteriaRequest): Promise<AcceptanceCriteria[]>;
}

export interface SecretResolver {
  get(secretRef: string): Promise<string | undefined>;
}

export interface Disposable {
  dispose(): void;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
