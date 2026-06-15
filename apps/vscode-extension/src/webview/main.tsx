import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Agent, ProviderConfig, TaskDetail, TaskEvidence, TaskPermissionMode, TaskPlanStep } from "@flint/core-types";
import "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

interface StateMessage {
  type: "state";
  tasks: TaskDetail[];
  selectedTaskId?: string;
  agents: Agent[];
  providers: Array<Omit<ProviderConfig, "secretRef"> & { hasSecret: boolean }>;
  providerSource: "globalState" | "settingsFallback" | "mockFallback";
  workspaceFolders: Array<{
    name: string;
    path: string;
    index: number;
  }>;
  defaultWorkspaceFolder: string;
  assets: {
    logoUri: string;
  };
}

type Message = StateMessage | { type: "focusTask"; taskId?: string };

// ── Status badge config ───────────────────────────────────────────────────────
const STATUS_BADGE: Record<string, { icon: string; label: string }> = {
  queued:          { icon: "○", label: "Queued" },
  planning:        { icon: "◈", label: "Planning" },
  dispatching:     { icon: "◈", label: "Dispatching" },
  running:         { icon: "●", label: "Running" },
  waiting_user:    { icon: "◐", label: "Waiting" },
  judging:         { icon: "◈", label: "Judging" },
  review_required: { icon: "⚑", label: "Review" },
  completed:       { icon: "✓", label: "Done" },
  failed:          { icon: "✕", label: "Failed" },
  cancelled:       { icon: "○", label: "Cancelled" },
  pass:            { icon: "✓", label: "Pass" },
  fail:            { icon: "✕", label: "Fail" },
  unknown:         { icon: "?", label: "Unknown" },
  planned:         { icon: "○", label: "Planned" },
  skipped:         { icon: "—", label: "Skipped" },
  success:         { icon: "✓", label: "Success" },
  success_with_findings: { icon: "◐", label: "Findings" },
  diagnostic_failure: { icon: "◈", label: "Diagnostic" },
  retryable_failure: { icon: "↻", label: "Retryable" },
  blocking_failure: { icon: "✕", label: "Blocking" },
  environment_missing: { icon: "!", label: "Missing env" },
  permission_denied: { icon: "!", label: "Denied" },
};

function StatusBadge({ status, className }: { status: string; className?: string }) {
  const { icon, label } = STATUS_BADGE[status] ?? { icon: "○", label: status };
  return <span className={`badge ${status}${className ? ` ${className}` : ""}`}>{icon} {label}</span>;
}

// ── Collapsible section ───────────────────────────────────────────────────────
function CollapsibleSection({
  title,
  count,
  name,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  name: string;
  expanded: boolean;
  onToggle: (name: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="collapsible">
      <button className="collapsible-header" onClick={() => onToggle(name)}>
        <span className="collapsible-arrow">{expanded ? "▾" : "▸"}</span>
        <span>{title}</span>
        {count !== undefined && <span className="collapsible-count">{count}</span>}
      </button>
      {expanded && <div className="collapsible-body">{children}</div>}
    </section>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<StateMessage["providers"]>([]);
  const [providerSource, setProviderSource] = useState<StateMessage["providerSource"]>("mockFallback");
  const [workspaceFolders, setWorkspaceFolders] = useState<StateMessage["workspaceFolders"]>([]);
  const [defaultWorkspaceFolder, setDefaultWorkspaceFolder] = useState("no-workspace");

  // View management
  const [view, setView] = useState<"list" | "detail" | "providers">("list");
  const [detailTaskId, setDetailTaskId] = useState<string | undefined>();
  const [composerOpen, setComposerOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["plan", "result", "eval"]));
  const [expandedStepId, setExpandedStepId] = useState<string | undefined>();
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>();
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | undefined>();

  // Provider form state
  const [providerMode, setProviderMode] = useState<"list" | "form">("list");
  const [editingProviderId, setEditingProviderId] = useState<string | undefined>();
  const [formType, setFormType] = useState<"openai-compatible" | "ollama">("openai-compatible");
  const [formId, setFormId] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formApiKey, setFormApiKey] = useState("");

  // Form state
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [taskWorkspaceId, setTaskWorkspaceId] = useState("");
  const [taskPermissionMode, setTaskPermissionMode] = useState<TaskPermissionMode>("ask");
  const [response, setResponse] = useState("");

  useEffect(() => {
    const listener = (event: MessageEvent<Message>) => {
      if (event.data.type === "state") {
        setTasks(event.data.tasks);
        setAgents(event.data.agents);
        setProviders(event.data.providers);
        setProviderSource(event.data.providerSource);
        setWorkspaceFolders(event.data.workspaceFolders);
        setDefaultWorkspaceFolder(event.data.defaultWorkspaceFolder);
        setTaskWorkspaceId((current) => {
          if (current && event.data.workspaceFolders.some((folder) => folder.path === current)) return current;
          return event.data.defaultWorkspaceFolder;
        });
        if (event.data.selectedTaskId) {
          setDetailTaskId(event.data.selectedTaskId);
          setView("detail");
        }
        setSelectedProviderId((current) => {
          if (current && event.data.providers.some((p) => p.id === current)) return current;
          return event.data.providers[0]?.id;
        });
      }
      if (event.data.type === "focusTask") {
        if (event.data.taskId) {
          setDetailTaskId(event.data.taskId);
          setView("detail");
        }
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "webviewReady" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const selected = useMemo(
    () => tasks.find((d) => d.task.id === detailTaskId),
    [detailTaskId, tasks]
  );
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? providers[0],
    [providers, selectedProviderId]
  );
  const running = tasks.filter((d) => ["dispatching", "planning", "running", "judging"].includes(d.task.status)).length;
  const waiting = tasks.filter((d) => d.task.status === "waiting_user").length;
  const enabledProviders = providers.filter((p) => p.enabled).length;

  useEffect(() => {
    if (!confirmDeleteTaskId) return;
    const timeout = window.setTimeout(() => setConfirmDeleteTaskId(undefined), 3000);
    return () => window.clearTimeout(timeout);
  }, [confirmDeleteTaskId]);

  function submitTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = taskTitle.trim();
    const prompt = taskPrompt.trim();
    const workspaceId = taskWorkspaceId || defaultWorkspaceFolder;
    if (!title || !prompt) return;
    vscode.postMessage({ type: "newTask", title, prompt, workspaceId, permissionMode: taskPermissionMode });
    setTaskTitle("");
    setTaskPrompt("");
    setTaskWorkspaceId(defaultWorkspaceFolder);
    setTaskPermissionMode("ask");
    setComposerOpen(false);
  }

  function openTask(taskId: string) {
    setConfirmDeleteTaskId(undefined);
    setDetailTaskId(taskId);
    setExpandedStepId(undefined);
    setView("detail");
  }

  function requestDeleteTask(taskId: string) {
    if (confirmDeleteTaskId !== taskId) {
      setConfirmDeleteTaskId(taskId);
      return;
    }
    vscode.postMessage({ type: "deleteTask", taskId });
    setConfirmDeleteTaskId(undefined);
    if (detailTaskId === taskId) {
      setDetailTaskId(undefined);
      setView("list");
    }
  }

  function toggleSection(name: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function goBack() {
    if (view === "providers" && providerMode === "form") {
      setProviderMode("list");
      return;
    }
    setView("list");
    setProviderMode("list");
  }

  function startNewProvider() {
    setEditingProviderId(undefined);
    setFormType("openai-compatible");
    setFormId("");
    setFormBaseUrl("https://api.openai.com/v1");
    setFormModel("gpt-4o-mini");
    setFormApiKey("");
    setProviderMode("form");
  }

  function startEditProvider(provider: StateMessage["providers"][number]) {
    setEditingProviderId(provider.id);
    setFormType(provider.type as "openai-compatible" | "ollama");
    setFormId(provider.id);
    setFormBaseUrl(provider.baseUrl);
    setFormModel(provider.model);
    setFormApiKey("");
    setProviderMode("form");
  }

  function saveProviderForm() {
    const id = formId.trim();
    const baseUrl = formBaseUrl.trim();
    const model = formModel.trim();
    if (!id || !baseUrl || !model) return;
    vscode.postMessage({
      type: "saveProvider",
      provider: { id, type: formType, baseUrl, model, enabled: true },
      apiKey: formType === "openai-compatible" ? formApiKey : undefined,
    });
    setProviderMode("list");
    setSelectedProviderId(id);
  }

  function deleteProvider(id: string) {
    vscode.postMessage({ type: "deleteProvider", providerId: id });
    if (selectedProviderId === id) setSelectedProviderId(undefined);
  }

  return (
    <main className="shell">

      {/* ── Header ── */}
      <header className="header">
        {view !== "list" && (
          <button className="back-btn" onClick={goBack} aria-label="Back to list">←</button>
        )}
        <span className="header-title">Fl<em>int</em></span>
        <div className="header-actions">
          {view === "list" && (
            <>
              <button onClick={() => vscode.postMessage({ type: "pauseAll" })}>Pause</button>
              <button onClick={() => vscode.postMessage({ type: "resumeAll" })}>Resume</button>
              <button onClick={() => setComposerOpen(!composerOpen)}>+</button>
            </>
          )}
          <button onClick={() => setView(view === "providers" ? "list" : "providers")}>
            {view === "providers" ? "Close" : "Providers"}
          </button>
        </div>
      </header>

      {/* ── List View ── */}
      {view === "list" && (
        <>
          {/* Composer (collapsible) */}
          {composerOpen && (
            <section className="composer">
              <form onSubmit={submitTask}>
                <input
                  className="composer-title"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder="Task title"
                  aria-label="Task title"
                  autoFocus
                />
                <textarea
                  className="composer-prompt"
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  placeholder="Describe the work Flint should run..."
                  aria-label="Task prompt"
                />
                <label className="composer-directory">
                  <span>Working directory</span>
                  {workspaceFolders.length > 1 ? (
                    <select
                      value={taskWorkspaceId || defaultWorkspaceFolder}
                      onChange={(e) => setTaskWorkspaceId(e.target.value)}
                      aria-label="Task working directory"
                    >
                      {workspaceFolders.map((folder) => (
                        <option key={folder.path} value={folder.path}>
                          {folder.name} · {folder.path}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={taskWorkspaceId || defaultWorkspaceFolder}
                      readOnly
                      aria-label="Task working directory"
                      title={taskWorkspaceId || defaultWorkspaceFolder}
                    />
                  )}
                </label>
                <label className="composer-directory">
                  <span>Task permissions</span>
                  <select
                    value={taskPermissionMode}
                    onChange={(e) => setTaskPermissionMode(e.target.value as TaskPermissionMode)}
                    aria-label="Task permissions"
                  >
                    <option value="ask">Ask before writes or commands</option>
                    <option value="full_access">Full access for this task</option>
                    <option value="read_only">Read-only</option>
                  </select>
                </label>
                <div className="composer-actions">
                  <span className="composer-meta">
                    {permissionModeDescription(taskPermissionMode)}
                  </span>
                  <button type="button" onClick={() => setComposerOpen(false)}>Cancel</button>
                  <button className="primary" type="submit" disabled={!taskTitle.trim() || !taskPrompt.trim()}>
                    Queue
                  </button>
                </div>
              </form>
            </section>
          )}

          {/* Task list or empty */}
          {tasks.length === 0 ? (
            <section className="empty">
              <FlintMark size={36} />
              <div className="empty-title">No tasks queued yet</div>
              <div className="empty-copy">Type a task above — Flint will plan, execute, and judge it automatically.</div>
              <div className="empty-tagline">Queue · Schedule · Ship</div>
            </section>
          ) : (
            <section className="task-list">
              {tasks.map((detail) => (
                <button
                  key={detail.task.id}
                  className={`task-row ${isActiveTask(detail) ? "active" : ""} ${confirmDeleteTaskId === detail.task.id ? "confirm-delete" : ""}`}
                  onClick={() => openTask(detail.task.id)}
                >
                  <span className={`task-indicator ${detail.task.status}`} />
                  <span className="task-content">
                    <span className="task-title">{detail.task.title}</span>
                    <span className="task-sub">
                      {isActiveTask(detail) && <span className="task-live-dot" aria-hidden="true" />}
                      {taskSubtitle(detail)}
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="task-delete"
                    aria-label={confirmDeleteTaskId === detail.task.id ? "Confirm delete task" : "Delete task"}
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDeleteTask(detail.task.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        requestDeleteTask(detail.task.id);
                      }
                    }}
                    onBlur={() => {
                      if (confirmDeleteTaskId === detail.task.id) setConfirmDeleteTaskId(undefined);
                    }}
                  >
                    {confirmDeleteTaskId === detail.task.id ? "Delete?" : "×"}
                  </span>
                  <span className="task-chevron">›</span>
                </button>
              ))}
              <div className="list-watermark" aria-hidden="true">
                <FlintMark size={96} />
                <span className="watermark-text">Flint</span>
              </div>
            </section>
          )}
        </>
      )}

      {/* ── Detail View ── */}
      {view === "detail" && selected && (
        <section className="detail-view">
          <div className="detail-header">
            <h2>{selected.task.title}</h2>
            <StatusBadge status={selected.task.status} />
          </div>
          <p className="detail-prompt">{selected.task.prompt}</p>
          <div className="detail-meta">
            <span>Working directory</span>
            <code title={selected.task.workspaceId}>{selected.task.workspaceId}</code>
          </div>
          <div className="permission-strip">
            <div>
              <span>Task permissions</span>
              <strong>{permissionModeLabel(selected.task.permissions?.mode ?? "ask")}</strong>
              {selected.task.permissions?.grantedScopes.length ? (
                <code>{selected.task.permissions.grantedScopes.join(", ")}</code>
              ) : null}
            </div>
            <select
              value={selected.task.permissions?.mode ?? "ask"}
              onChange={(e) =>
                vscode.postMessage({
                  type: "setTaskPermissionMode",
                  taskId: selected.task.id,
                  permissionMode: e.target.value
                })
              }
              aria-label="Update task permissions"
            >
              <option value="ask">Ask</option>
              <option value="full_access">Full access</option>
              <option value="read_only">Read-only</option>
            </select>
          </div>

          {/* Waiting-for-user */}
          {selected.task.status === "waiting_user" && selected.task.userInputRequest && (
            <div className="modal-inline">
              <div className="modal-inline-head">
                <span className="modal-label">Input required</span>
              </div>
              {currentStep(selected) && (
                <div className="blocked-step">Blocked at: {currentStep(selected)?.title}</div>
              )}
              <div className="question">{selected.task.userInputRequest.question}</div>
              {selected.task.userInputRequest.context && <p>{selected.task.userInputRequest.context}</p>}
              <textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder="Reply and resume task..."
              />
              <div className="row-actions">
                <button
                  className="primary"
                  onClick={() => {
                    vscode.postMessage({ type: "respondUserInput", taskId: selected.task.id, response });
                    setResponse("");
                  }}
                >
                  Submit &amp; Resume
                </button>
                <button onClick={() => vscode.postMessage({ type: "cancelTask", taskId: selected.task.id })}>
                  Cancel Task
                </button>
              </div>
              <div className="hint">Agent remains reserved while waiting.</div>
            </div>
          )}

          {/* Plan section */}
          <CollapsibleSection
            title="Plan"
            count={selected.task.plan?.steps.length}
            name="plan"
            expanded={expandedSections.has("plan")}
            onToggle={toggleSection}
          >
            {selected.task.plan ? (
              <>
                <p className="plan-summary">{selected.task.plan.summary}</p>
                <div className="steps">
                  {selected.task.plan.steps.map((step) => (
                    <React.Fragment key={step.id}>
                      <button
                        className={`step-row ${selected.task.currentStepId === step.id ? "current" : ""}`}
                        onClick={() => setExpandedStepId(expandedStepId === step.id ? undefined : step.id)}
                      >
                        <span className="step-num">{step.index}</span>
                        <span className="step-title">{step.title}</span>
                        <span className={`step-status-text ${step.status}`}>
                          {STATUS_BADGE[step.status]?.label ?? step.status}
                        </span>
                      </button>
                      {expandedStepId === step.id && (
                        <div className="step-expanded">
                          {step.detail && <p className="step-detail">{step.detail}</p>}
                          {step.outputSummary && <p className="step-output">{step.outputSummary}</p>}
                          {step.error && <p className="step-error">{step.error}</p>}
                          {!step.detail && !step.outputSummary && !step.error && (
                            <p className="muted">No details yet.</p>
                          )}
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">Plan will appear after the task starts.</p>
            )}
          </CollapsibleSection>

          {/* Result section */}
          <CollapsibleSection
            title="Result"
            count={selected.task.result?.revision}
            name="result"
            expanded={expandedSections.has("result")}
            onToggle={toggleSection}
          >
            {selected.task.result ? (
              <div className="result-panel">
                <div className="result-meta">
                  <span>Revision {selected.task.result.revision}</span>
                  <span>{selected.task.result.format}</span>
                  {selected.task.status === "running" && selected.task.evaluationAttempts ? (
                    <span className="result-iterating">Iterating after evaluation</span>
                  ) : null}
                </div>
                <div className="markdown-result">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => (
                        <a href={href} title={href}>
                          {children}
                        </a>
                      )
                    }}
                  >
                    {selected.task.result.content}
                  </ReactMarkdown>
                </div>
                <ExecutionDiagnostics evidence={selected.task.evidence ?? []} />
              </div>
            ) : (
              <p className="muted">Result will appear after execution.</p>
            )}
          </CollapsibleSection>

          {/* Evaluation section */}
          <CollapsibleSection
            title="Evaluation"
            name="eval"
            expanded={expandedSections.has("eval")}
            onToggle={toggleSection}
          >
            {selected.evaluation ? (
              <div className="judge">
                <div className="judge-head">
                  <StatusBadge status={selected.evaluation.verdict} />
                  <span className="muted">{Math.round(selected.evaluation.confidence * 100)}% confidence</span>
                  {selected.evaluation.revision && <span className="muted">revision {selected.evaluation.revision}</span>}
                </div>
                {(selected.evaluation.judgeRationale ?? selected.evaluation.rationale) && (
                  <p>{selected.evaluation.judgeRationale ?? selected.evaluation.rationale}</p>
                )}
                {selected.evaluation.criteriaResults?.length ? (
                  <div className="criteria-list">
                    <span className="eval-label">Acceptance criteria</span>
                    {selected.evaluation.criteriaResults.map((criteria) => (
                      <div key={criteria.criteriaId} className={`criteria-card ${criteria.status}`}>
                        <div className="criteria-card-head">
                          <StatusBadge status={criteria.status} />
                          <strong>{criteria.statement}</strong>
                        </div>
                        <p>{criteria.rationale}</p>
                        {criteria.evidenceRefs.length > 0 && (
                          <code>{criteria.evidenceRefs.join(", ")}</code>
                        )}
                        {criteria.nextSteps?.length ? (
                          <ul>
                            {criteria.nextSteps.map((step) => <li key={step}>{step}</li>)}
                          </ul>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="score-grid">
                    {Object.entries(selected.evaluation.scores).map(([name, score]) => (
                      <span key={name}>
                        <strong>{name}</strong>
                        {Math.round(score * 100)}
                      </span>
                    ))}
                  </div>
                )}
                {selected.evaluation.missingEvidence?.length ? (
                  <div className="eval-list">
                    <span className="eval-label">Missing evidence</span>
                    {selected.evaluation.missingEvidence.map((item) => <p key={item}>{item}</p>)}
                  </div>
                ) : null}
                {selected.evaluation.findings.length > 0 && (
                  <div className="eval-list">
                    <span className="eval-label">Findings</span>
                    {selected.evaluation.findings.map((finding) => <p key={finding}>{finding}</p>)}
                  </div>
                )}
                {(selected.evaluation.nextSteps ?? selected.evaluation.suggestedNextSteps)?.length ? (
                  <div className="eval-list">
                    <span className="eval-label">Suggested next steps</span>
                    {(selected.evaluation.nextSteps ?? selected.evaluation.suggestedNextSteps ?? []).map((step) => (
                      <p key={step.title}>
                        <strong>{step.title}</strong>
                        {step.detail ? ` · ${step.detail}` : ""}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="muted">No evaluation yet.</p>
            )}
          </CollapsibleSection>

          {/* Actions */}
          <div className="detail-actions">
            <button onClick={() => vscode.postMessage({ type: "retryTask", taskId: selected.task.id })}>Retry</button>
            <button onClick={() => vscode.postMessage({ type: "cancelTask", taskId: selected.task.id })}>Cancel</button>
            <button className="danger" onClick={() => requestDeleteTask(selected.task.id)}>
              {confirmDeleteTaskId === selected.task.id ? "Delete?" : "Delete"}
            </button>
          </div>
        </section>
      )}

      {/* ── Detail View: task not found ── */}
      {view === "detail" && !selected && (
        <section className="empty">
          <div className="empty-title">Task not found</div>
          <button onClick={goBack}>Back to list</button>
        </section>
      )}

      {/* ── Providers View ── */}
      {view === "providers" && providerMode === "list" && (
        <section className="providers-view">
          <div className="provider-list">
            {providers.length ? (
              providers.map((provider) => (
                <div
                  key={provider.id}
                  className={`provider-card ${selectedProviderId === provider.id ? "selected" : ""}`}
                  onClick={() => setSelectedProviderId(selectedProviderId === provider.id ? undefined : provider.id)}
                >
                  <div className="provider-card-header">
                    <span className={`provider-dot ${provider.enabled ? "enabled" : ""}`} />
                    <strong>{provider.id}</strong>
                    <span className="provider-card-type">{provider.type}</span>
                  </div>
                  {selectedProviderId === provider.id && (
                    <div className="provider-card-detail">
                      <div className="provider-field">
                        <span className="provider-field-label">Model</span>
                        <span className="provider-field-value">{provider.model}</span>
                      </div>
                      <div className="provider-field">
                        <span className="provider-field-label">Base URL</span>
                        <span className="provider-field-value">{provider.baseUrl}</span>
                      </div>
                      <div className="provider-field">
                        <span className="provider-field-label">API Key</span>
                        <span className="provider-field-value">{providerSecretLabel(provider)}</span>
                      </div>
                      <div className="provider-field">
                        <span className="provider-field-label">Source</span>
                        <span className="provider-field-value">{providerSourceLabel(providerSource)}</span>
                      </div>
                      <div className="provider-card-actions">
                        <button onClick={(e) => { e.stopPropagation(); startEditProvider(provider); }}>Edit</button>
                        <button className="danger" onClick={(e) => { e.stopPropagation(); deleteProvider(provider.id); }}>Delete</button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="provider-empty">
                <p>No provider configured</p>
                <p className="muted">Flint is using the mock provider.</p>
              </div>
            )}
          </div>
          <div className="provider-bottom-actions">
            <button onClick={() => vscode.postMessage({ type: "refreshProviders" })}>Refresh</button>
            <button className="primary" onClick={() => startNewProvider()}>Add Provider</button>
          </div>
        </section>
      )}

      {/* ── Provider Form ── */}
      {view === "providers" && providerMode === "form" && (
        <section className="providers-view">
          <h2 className="form-heading">{editingProviderId ? "Edit Provider" : "New Provider"}</h2>

          <div className="form-group">
            <label className="form-label">Type</label>
            <div className="form-toggle">
              <button
                className={`toggle-btn ${formType === "openai-compatible" ? "active" : ""}`}
                onClick={() => { setFormType("openai-compatible"); setFormBaseUrl("https://api.openai.com/v1"); setFormModel("gpt-4o-mini"); }}
              >
                OpenAI Compatible
              </button>
              <button
                className={`toggle-btn ${formType === "ollama" ? "active" : ""}`}
                onClick={() => { setFormType("ollama"); setFormBaseUrl("http://localhost:11434"); setFormModel("llama3.1"); setFormApiKey(""); }}
              >
                Ollama
              </button>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="prov-id">Provider ID</label>
            <input
              id="prov-id"
              value={formId}
              onChange={(e) => setFormId(e.target.value)}
              placeholder={formType === "ollama" ? "ollama-local" : "my-provider"}
              disabled={!!editingProviderId}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="prov-url">Base URL</label>
            <input
              id="prov-url"
              value={formBaseUrl}
              onChange={(e) => setFormBaseUrl(e.target.value)}
              placeholder={formType === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1"}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="prov-model">Model</label>
            <input
              id="prov-model"
              value={formModel}
              onChange={(e) => setFormModel(e.target.value)}
              placeholder={formType === "ollama" ? "llama3.1" : "gpt-4o-mini"}
            />
          </div>

          {formType === "openai-compatible" && (
            <div className="form-group">
              <label className="form-label" htmlFor="prov-key">API Key</label>
              <input
                id="prov-key"
                type="password"
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                placeholder="sk-..."
              />
              <span className="form-hint">Stored securely in VS Code SecretStorage</span>
            </div>
          )}

          <div className="form-actions">
            <button onClick={() => setProviderMode("list")}>Cancel</button>
            <button
              className="primary"
              disabled={!formId.trim() || !formBaseUrl.trim() || !formModel.trim()}
              onClick={saveProviderForm}
            >
              {editingProviderId ? "Save Changes" : "Add Provider"}
            </button>
          </div>
        </section>
      )}

      {/* ── Status Bar ── */}
      <footer className="status-bar">
        {running > 0 && (
          <>
            <span className="status-dot running" />
            <span>{running} running</span>
            <span className="status-sep">·</span>
          </>
        )}
        {waiting > 0 && (
          <>
            <span className="status-dot waiting" />
            <span>{waiting} waiting</span>
            <span className="status-sep">·</span>
          </>
        )}
        <span>{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
        <span className="status-spacer" />
        <span>{enabledProviders || "mock"} provider{enabledProviders !== 1 ? "s" : ""}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

// ── FlintMark SVG ─────────────────────────────────────────────────────────────
function FlintMark({ size }: { size: number }) {
  return (
    <svg className="flint-mark" width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <path
        d="M20 52 L32 20 L44 36 L52 24"
        stroke="#5EE6A3"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="52" cy="24" r={5} fill="#5EE6A3" />
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function taskSubtitle(detail: TaskDetail): string {
  const task = detail.task;
  const step = currentStep(detail);
  const total = task.plan?.steps.length ?? 0;

  if (task.status === "planning") {
    return total > 0 ? `Planning ${total} steps` : "Planning steps...";
  }
  if (task.status === "waiting_user") {
    return step && total > 0 ? `Input needed · Step ${step.index}/${total}` : "Input needed";
  }
  if (task.status === "judging") {
    return "Evaluating result...";
  }
  if (step && total > 0) {
    return `Step ${step.index}/${total} · ${step.title}`;
  }
  return `${task.agentId ?? "unassigned"} · ${detail.events.at(-1)?.type ?? "created"}`;
}

function isActiveTask(detail: TaskDetail): boolean {
  return ["dispatching", "planning", "running", "judging"].includes(detail.task.status);
}

function ExecutionDiagnostics({ evidence }: { evidence: TaskEvidence[] }) {
  const commandEvidence = evidence.filter((item) => item.command || item.outcome);
  if (!commandEvidence.length) {
    return null;
  }
  return (
    <div className="execution-diagnostics">
      <div className="execution-diagnostics-head">
        <span>Execution Diagnostics</span>
        <span>{commandEvidence.length}</span>
      </div>
      {commandEvidence.slice(-12).map((item) => {
        const semantic = item.outcome?.semanticStatus ?? item.status;
        return (
          <div key={item.id} className={`diagnostic-card ${semantic}`}>
            <div className="diagnostic-card-head">
              <StatusBadge status={semantic} />
              <span>{item.outcome?.category ?? item.toolName}</span>
              {item.outcome?.blocksCompletion ? <strong>blocks</strong> : null}
            </div>
            <p>{item.outcome?.summary ?? item.summary}</p>
            {item.command ? <code>{item.command}</code> : null}
            {item.outcome?.artifacts?.length ? (
              <div className="diagnostic-artifacts">
                {item.outcome.artifacts.map((artifact) => (
                  <span key={`${item.id}-${artifact.path}`}>{artifact.kind}: {artifact.path}</span>
                ))}
              </div>
            ) : null}
            {item.outcome?.suggestedRecovery?.length ? (
              <ul>
                {item.outcome.suggestedRecovery.map((recovery) => <li key={recovery}>{recovery}</li>)}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function currentStep(detail: TaskDetail): TaskPlanStep | undefined {
  const task = detail.task;
  return (
    task.plan?.steps.find((step) => step.id === task.currentStepId) ??
    task.plan?.steps.find((step) => step.status === "running") ??
    task.plan?.steps.find((step) => step.status === "planned")
  );
}

function providerSourceLabel(source: StateMessage["providerSource"]): string {
  if (source === "globalState") return "Global extension state";
  if (source === "settingsFallback") return "VS Code settings";
  return "Mock fallback";
}

function providerSecretLabel(provider: StateMessage["providers"][number]): string {
  if (provider.type === "ollama") return "No API key required";
  return provider.hasSecret ? "Stored in SecretStorage" : "Missing API key";
}

function permissionModeLabel(mode: TaskPermissionMode): string {
  if (mode === "full_access") return "Full access";
  if (mode === "read_only") return "Read-only";
  return "Ask before action";
}

function permissionModeDescription(mode: TaskPermissionMode): string {
  if (mode === "full_access") return "Writes and commands run without prompts";
  if (mode === "read_only") return "File writes and terminal commands are denied";
  return "Flint will ask before writes or commands";
}
