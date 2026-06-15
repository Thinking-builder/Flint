import * as path from "node:path";
import * as vscode from "vscode";
import type { ProviderConfig, Task, TaskDetail, TaskPermissionMode, ToolPermissionDecision, ToolPermissionRequest } from "@flint/core-types";
import type { DiagnosticEntry } from "@flint/workspace-tools";
import { FlintOrchestrator } from "@flint/orchestrator";
import { createProviderAdapter, MockProvider } from "@flint/providers";
import { createStorage } from "@flint/storage";

const PROVIDERS_GLOBAL_STATE_KEY = "flint.providers.v1";

let queueView: FlintQueueViewProvider | undefined;
let orchestrator: FlintOrchestrator | undefined;
let statusBar: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  orchestrator = await createOrchestrator(context);
  queueView = new FlintQueueViewProvider(context, orchestrator);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "flint.openQueue";
  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider("flint.queue", queueView, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("flint.newTask", () => createTaskFromInput()),
    vscode.commands.registerCommand("flint.openQueue", () => vscode.commands.executeCommand("workbench.view.extension.flint")),
    vscode.commands.registerCommand("flint.configureProvider", () => configureProvider(context)),
    vscode.commands.registerCommand("flint.cancelTask", (taskId?: string) => taskId && orchestrator?.cancelTask(taskId)),
    vscode.commands.registerCommand("flint.retryTask", (taskId?: string) => taskId && orchestrator?.retryTask(taskId)),
    vscode.commands.registerCommand("flint.openTaskDetail", (taskId?: string) => queueView?.focusTask(taskId)),
    vscode.commands.registerCommand("flint.pauseAll", () => {
      orchestrator?.pauseAll();
      void refreshAll();
    }),
    vscode.commands.registerCommand("flint.resumeAll", () => {
      orchestrator?.resumeAll();
      void refreshAll();
    })
  );

  orchestrator.subscribeTaskEvents("all", async (event) => {
    await refreshAll();
    if (event.type === "agent.waiting_user") {
      void vscode.window.showWarningMessage("Flint task is waiting for your input.", "Open").then((choice) => {
        if (choice === "Open") {
          void vscode.commands.executeCommand("flint.openQueue");
        }
      });
    }
    if (event.type === "task.finished") {
      const status = String(event.payload.status ?? "");
      const message = status === "completed" ? "Flint task completed." : `Flint task finished: ${status}`;
      void vscode.window.showInformationMessage(message, "Open").then((choice) => {
        if (choice === "Open") {
          void vscode.commands.executeCommand("flint.openQueue");
        }
      });
    }
    if (event.type === "task.failed") {
      void vscode.window.showErrorMessage(`Flint task failed: ${String(event.payload.error ?? "Unknown error")}`);
    }
  });

  await refreshAll();
}

export function deactivate(): void {
  statusBar?.dispose();
}

async function createOrchestrator(context: vscode.ExtensionContext): Promise<FlintOrchestrator> {
  const storagePath = path.join(context.globalStorageUri.fsPath, "flint-state.json");
  const storage = await createStorage(storagePath);
  const providers = getProviderState(context).providers
    .filter((provider) => provider.enabled)
    .map((provider) => createProviderAdapter(provider, { get: (secretRef) => Promise.resolve(context.secrets.get(secretRef)) }));

  return new FlintOrchestrator({
    storage,
    providers: providers.length > 0 ? providers : [new MockProvider()],
    workspaceId: getWorkspaceId(),
    workspaceIds: getWorkspaceFolders().map((folder) => folder.path),
    maxConcurrentTasks: vscode.workspace.getConfiguration("flint").get<number>("maxConcurrentTasks", 2),
    defaultPermissionMode: vscode.workspace.getConfiguration("flint").get<TaskPermissionMode>("defaultTaskPermissionMode", "ask"),
    allowFileWrites: vscode.workspace.getConfiguration("flint").get<boolean>("allowFileWrites", false),
    allowTerminalCommands: vscode.workspace.getConfiguration("flint").get<boolean>("allowTerminalCommands", false),
    diagnosticsResolver: resolveVsCodeDiagnostics,
    requestToolPermission
  });
}

async function resolveVsCodeDiagnostics(uri?: string): Promise<DiagnosticEntry[]> {
  const severityMap: Record<number, DiagnosticEntry["severity"]> = {
    [vscode.DiagnosticSeverity.Error]: "error",
    [vscode.DiagnosticSeverity.Warning]: "warning",
    [vscode.DiagnosticSeverity.Information]: "info",
    [vscode.DiagnosticSeverity.Hint]: "hint"
  };
  const diagnosticPairs = uri
    ? [[vscode.Uri.parse(uri), vscode.languages.getDiagnostics(vscode.Uri.parse(uri))] as const]
    : vscode.languages.getDiagnostics();
  const entries: DiagnosticEntry[] = [];
  for (const [fileUri, diagnostics] of diagnosticPairs) {
    for (const d of diagnostics) {
      entries.push({
        file: vscode.workspace.asRelativePath(fileUri),
        severity: severityMap[d.severity] ?? "info",
        message: d.message,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1
      });
    }
  }
  return entries;
}

async function createTaskFromInput(): Promise<void> {
  if (!orchestrator) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: "New Flint Task",
    prompt: "Task title",
    ignoreFocusOut: true
  });
  if (!title) {
    return;
  }
  const prompt = await vscode.window.showInputBox({
    title: "New Flint Task",
    prompt: "Describe the work Flint should run",
    value: title,
    ignoreFocusOut: true
  });
  if (!prompt) {
    return;
  }
  const workspaceId = await pickWorkspaceId();
  if (!workspaceId) {
    return;
  }
  const permissionMode = await pickPermissionMode();
  if (!permissionMode) {
    return;
  }
  await orchestrator.createTask({ title, prompt, workspaceId, permissionMode });
  await vscode.commands.executeCommand("flint.openQueue");
  await refreshAll();
}

async function configureProvider(context: vscode.ExtensionContext): Promise<void> {
  const type = await vscode.window.showQuickPick(
    [
      { label: "openai-compatible", description: "OpenAI, OpenRouter, LM Studio compatible APIs" },
      { label: "ollama", description: "Local Ollama server" }
    ],
    { title: "Flint Provider Type", ignoreFocusOut: true }
  );
  if (!type) {
    return;
  }

  const id = await vscode.window.showInputBox({
    title: "Provider ID",
    value: type.label === "ollama" ? "ollama-local" : "openai-compatible",
    ignoreFocusOut: true
  });
  if (!id) {
    return;
  }

  const baseUrl = await vscode.window.showInputBox({
    title: "Provider Base URL",
    value: type.label === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1",
    ignoreFocusOut: true
  });
  if (!baseUrl) {
    return;
  }

  const model = await vscode.window.showInputBox({
    title: "Provider Model",
    value: type.label === "ollama" ? "llama3.1" : "gpt-4o-mini",
    ignoreFocusOut: true
  });
  if (!model) {
    return;
  }

  const secretRef = `flint.provider.${id}.apiKey`;
  if (type.label === "openai-compatible") {
    const apiKey = await vscode.window.showInputBox({
      title: "Provider API Key",
      password: true,
      ignoreFocusOut: true,
      prompt: "Stored in VS Code SecretStorage"
    });
    if (apiKey) {
      await context.secrets.store(secretRef, apiKey);
    }
  }

  const providers = getProviderState(context).providers.filter((provider) => provider.id !== id);
  providers.push({
    id,
    type: type.label as ProviderConfig["type"],
    baseUrl,
    model,
    secretRef: type.label === "openai-compatible" ? secretRef : undefined,
    enabled: true
  });
  await saveProviderConfigs(context, providers);

  orchestrator = await createOrchestrator(context);
  queueView?.setOrchestrator(orchestrator);
  await refreshAll();
}

interface ProviderState {
  providers: ProviderConfig[];
  source: "globalState" | "settingsFallback" | "mockFallback";
}

interface WorkspaceFolderInfo {
  name: string;
  path: string;
  index: number;
}

function getProviderState(context: vscode.ExtensionContext): ProviderState {
  const globalProviders = context.globalState.get<ProviderConfig[]>(PROVIDERS_GLOBAL_STATE_KEY, []);
  if (Array.isArray(globalProviders) && globalProviders.length > 0) {
    return { providers: globalProviders, source: "globalState" };
  }

  const settingsProviders = vscode.workspace.getConfiguration("flint").get<ProviderConfig[]>("providers", []);
  if (Array.isArray(settingsProviders) && settingsProviders.length > 0) {
    return { providers: settingsProviders, source: "settingsFallback" };
  }

  return { providers: [], source: "mockFallback" };
}

async function saveProviderConfigs(context: vscode.ExtensionContext, providers: ProviderConfig[]): Promise<void> {
  await context.globalState.update(PROVIDERS_GLOBAL_STATE_KEY, providers);
  await vscode.workspace.getConfiguration("flint").update("providers", providers, vscode.ConfigurationTarget.Global);
}

function getWorkspaceFolders(): WorkspaceFolderInfo[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
    name: folder.name,
    path: folder.uri.fsPath,
    index
  }));
}

function getWorkspaceId(): string {
  return getWorkspaceFolders()[0]?.path ?? "no-workspace";
}

function resolveWorkspaceId(candidate: unknown): string {
  if (typeof candidate !== "string") {
    return getWorkspaceId();
  }
  const requested = candidate.trim();
  const folders = getWorkspaceFolders();
  if (folders.length === 0) {
    return requested || "no-workspace";
  }
  return folders.some((folder) => folder.path === requested) ? requested : getWorkspaceId();
}

function resolvePermissionMode(candidate: unknown): TaskPermissionMode {
  return candidate === "full_access" || candidate === "read_only" || candidate === "ask" ? candidate : "ask";
}

async function pickWorkspaceId(): Promise<string | undefined> {
  const folders = getWorkspaceFolders();
  if (folders.length <= 1) {
    return getWorkspaceId();
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.path,
      workspaceId: folder.path
    })),
    {
      title: "Flint Task Working Directory",
      placeHolder: "Select the workspace folder for this task",
      ignoreFocusOut: true
    }
  );
  return picked?.workspaceId;
}

async function pickPermissionMode(): Promise<TaskPermissionMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "Ask before writes or commands", description: "Recommended", mode: "ask" as const },
      { label: "Full access for this task", description: "No approval prompts for file writes or terminal commands", mode: "full_access" as const },
      { label: "Read-only", description: "Planning, reading, search, and evaluation only", mode: "read_only" as const }
    ],
    {
      title: "Flint Task Permissions",
      placeHolder: "Choose what this task may do",
      ignoreFocusOut: true
    }
  );
  return picked?.mode;
}

async function requestToolPermission(request: ToolPermissionRequest, task: Task): Promise<ToolPermissionDecision> {
  const approveOnce: vscode.MessageItem & { decision: ToolPermissionDecision } = { title: "Approve Once", decision: "approved_once" };
  const approveScope: vscode.MessageItem & { decision: ToolPermissionDecision } = {
    title: request.scope === "file_write" ? "Allow Writes For Task" : "Allow Commands For Task",
    decision: "approved_for_task"
  };
  const fullAccess: vscode.MessageItem & { decision: ToolPermissionDecision } = { title: "Full Access For Task", decision: "full_access" };
  const deny: vscode.MessageItem & { decision: ToolPermissionDecision } = { title: "Deny", decision: "denied", isCloseAffordance: true };
  const choice = await vscode.window.showWarningMessage(
    `Flint needs permission for ${request.toolCall.name}`,
    {
      modal: true,
      detail: [
        `Task: ${task.title}`,
        `Workspace: ${task.workspaceId}`,
        `Reason: ${request.reason}`,
        describeToolCall(request)
      ].filter(Boolean).join("\n")
    },
    approveOnce,
    approveScope,
    fullAccess,
    deny
  );
  return choice?.decision ?? "denied";
}

function describeToolCall(request: ToolPermissionRequest): string {
  const input = request.toolCall.input;
  if (request.toolCall.name === "writeFile") {
    const bytes = typeof input.content === "string" ? input.content.length : 0;
    return `File: ${String(input.path ?? "")}\nWrite size: ${bytes} chars`;
  }
  if (request.toolCall.name === "applyPatch") {
    return `File: ${String(input.path ?? "")}\nPatch: ${String(input.search ?? "").length} chars -> ${String(input.replace ?? "").length} chars`;
  }
  if (request.toolCall.name === "runCommand" || request.toolCall.name === "runTests") {
    return `Command: ${String(input.command ?? "npm test")}`;
  }
  return "";
}

async function refreshAll(): Promise<void> {
  if (!orchestrator) {
    return;
  }
  const folders = getWorkspaceFolders();
  const allTasks = await orchestrator.listTasks();
  const tasks =
    folders.length > 0
      ? allTasks.filter((task) => folders.some((folder) => folder.path === task.workspaceId))
      : allTasks.filter((task) => task.workspaceId === "no-workspace");
  const details = await Promise.all(tasks.map((task) => orchestrator?.getTask(task.id)));
  queueView?.postState(details.filter(Boolean) as TaskDetail[]);
  const running = tasks.filter((task) => task.status === "running" || task.status === "dispatching").length;
  const waiting = tasks.filter((task) => task.status === "waiting_user").length;
  statusBar!.text = `$(flame) Flint ${running} running / ${waiting} waiting`;
}

class FlintQueueViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private selectedTaskId?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private currentOrchestrator: FlintOrchestrator
  ) {}

  setOrchestrator(next: FlintOrchestrator): void {
    this.currentOrchestrator = next;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    void refreshAll();
    setTimeout(() => void refreshAll(), 100);
  }

  focusTask(taskId?: string): void {
    this.selectedTaskId = taskId;
    void vscode.commands.executeCommand("flint.openQueue");
    this.view?.webview.postMessage({ type: "focusTask", taskId });
  }

  postState(tasks: TaskDetail[]): void {
    const providerState = getProviderState(this.context);
    const workspaceFolders = getWorkspaceFolders();
    const logoUri = this.view
      ? this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "logo-icon.svg")).toString()
      : "";
    this.view?.webview.postMessage({
      type: "state",
      tasks,
      selectedTaskId: this.selectedTaskId,
      agents: this.currentOrchestrator.getAgents(),
      providers: sanitizeProviders(providerState.providers),
      providerSource: providerState.source,
      workspaceFolders,
      defaultWorkspaceFolder: getWorkspaceId(),
      assets: {
        logoUri
      }
    });
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    if (message.type === "newTask") {
      if (typeof message.title === "string" && typeof message.prompt === "string") {
        const title = message.title.trim();
        const prompt = message.prompt.trim();
        if (title && prompt) {
          await this.currentOrchestrator.createTask({
            title,
            prompt,
            workspaceId: resolveWorkspaceId(message.workspaceId),
            permissionMode: resolvePermissionMode(message.permissionMode)
          });
        }
      } else {
        await createTaskFromInput();
      }
    }
    if (message.type === "configureProvider") {
      await configureProvider(this.context);
    }
    if (message.type === "saveProvider" && message.provider) {
      const p = message.provider as { id: string; type: string; baseUrl: string; model: string; enabled: boolean };
      const secretRef = `flint.provider.${p.id}.apiKey`;
      if (typeof message.apiKey === "string" && message.apiKey) {
        await this.context.secrets.store(secretRef, message.apiKey);
      }
      const existing = getProviderState(this.context).providers.filter((prov) => prov.id !== p.id);
      existing.push({
        id: p.id,
        type: p.type as ProviderConfig["type"],
        baseUrl: p.baseUrl,
        model: p.model,
        secretRef: p.type === "openai-compatible" ? secretRef : undefined,
        enabled: p.enabled,
      });
      await saveProviderConfigs(this.context, existing);
      orchestrator = await createOrchestrator(this.context);
      this.currentOrchestrator = orchestrator;
    }
    if (message.type === "deleteProvider" && typeof message.providerId === "string") {
      const existing = getProviderState(this.context).providers.filter((prov) => prov.id !== message.providerId);
      await saveProviderConfigs(this.context, existing);
      const secretRef = `flint.provider.${message.providerId}.apiKey`;
      await this.context.secrets.delete(secretRef);
      orchestrator = await createOrchestrator(this.context);
      this.currentOrchestrator = orchestrator;
    }
    if (message.type === "webviewReady") {
      await refreshAll();
    }
    if (message.type === "refreshProviders") {
      await refreshAll();
    }
    if (message.type === "cancelTask" && message.taskId) {
      await this.currentOrchestrator.cancelTask(message.taskId as string);
    }
    if (message.type === "deleteTask" && message.taskId) {
      await this.currentOrchestrator.deleteTask(message.taskId as string);
      if (this.selectedTaskId === message.taskId) {
        this.selectedTaskId = undefined;
      }
    }
    if (message.type === "retryTask" && message.taskId) {
      await this.currentOrchestrator.retryTask(message.taskId as string);
    }
    if (message.type === "setTaskPermissionMode" && message.taskId) {
      await this.currentOrchestrator.updateTaskPermissions(message.taskId as string, resolvePermissionMode(message.permissionMode));
    }
    if (message.type === "respondUserInput" && message.taskId && typeof message.response === "string") {
      await this.currentOrchestrator.respondToUserInput(message.taskId as string, message.response);
    }
    if (message.type === "pauseAll") {
      this.currentOrchestrator.pauseAll();
    }
    if (message.type === "resumeAll") {
      this.currentOrchestrator.resumeAll();
    }
    await refreshAll();
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "assets", "index.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "assets", "index.css"));
    const nonce = String(Date.now());
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Pacifico&display=swap">
  <link rel="stylesheet" href="${styleUri}">
  <title>Flint</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function sanitizeProviders(providers: ProviderConfig[]): Array<Omit<ProviderConfig, "secretRef"> & { hasSecret: boolean }> {
  return providers.map(({ secretRef, ...provider }) => ({ ...provider, hasSecret: Boolean(secretRef) }));
}
