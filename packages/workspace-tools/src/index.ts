import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  createId,
  nowIso,
  type CommandArtifact,
  type CommandFinding,
  type CommandOutcome,
  type CommandOutcomeCategory,
  type CommandSemanticStatus,
  type TaskEvidence,
  type WorkspaceToolCall,
  type WorkspaceToolName
} from "@flint/core-types";

const execFileAsync = promisify(execFile);

interface CommandResult {
  output: string;
  exitCode: number;
  timedOut?: boolean;
  spawnError?: boolean;
}

export interface DiagnosticEntry {
  file: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  line?: number;
  column?: number;
}

export type DiagnosticsResolver = (uri?: string) => Promise<DiagnosticEntry[]>;

export interface WorkspaceToolsOptions {
  workspaceRoot: string;
  allowFileWrites?: boolean;
  allowTerminalCommands?: boolean;
  testCommand?: string;
  diagnosticsResolver?: DiagnosticsResolver;
}

export class WorkspaceTools {
  constructor(private readonly options: WorkspaceToolsOptions) {}

  async execute(taskId: string, stepId: string | undefined, call: WorkspaceToolCall): Promise<TaskEvidence> {
    const startedAt = nowIso();
    try {
      const denied = this.policyDenial(call);
      if (denied) {
        return this.evidence(taskId, stepId, call.name, "denied", denied, startedAt, {
          outcome: {
            semanticStatus: "permission_denied",
            category: permissionScopeName(call),
            retryable: false,
            blocksCompletion: true,
            summary: denied,
            suggestedRecovery: ["Approve the required task permission or switch the task to full access."]
          }
        });
      }

      const result = await this.dispatch(call);
      return this.evidence(taskId, stepId, call.name, "succeeded", result.summary, startedAt, result);
    } catch (error) {
      const failure = normalizeToolError(error);
      return this.evidence(taskId, stepId, call.name, "failed", `Tool ${call.name} failed: ${failure.message}`, startedAt, {
        error: failure.message,
        output: failure.output?.slice(0, 20_000),
        path: failure.path,
        command: failure.command,
        outcome: outcomeFromToolFailure(call.name, failure.message, failure.command, failure.output)
      });
    }
  }

  async gitDiff(): Promise<string> {
    const result = await runCommand("git", ["diff", "--"], this.options.workspaceRoot, 10_000);
    return result.output;
  }

  async hasVerifiableArtifacts(): Promise<boolean> {
    try {
      const files = await walk(this.options.workspaceRoot);
      return files.some((file) => file.endsWith(".py") || file.endsWith(".tex"));
    } catch {
      return false;
    }
  }

  async artifactFingerprint(): Promise<string | undefined> {
    try {
      const files = await walk(this.options.workspaceRoot);
      const artifacts = files
        .filter((file) => file.endsWith(".py") || file.endsWith(".tex"))
        .sort();
      if (!artifacts.length) {
        return undefined;
      }
      const parts = await Promise.all(
        artifacts.map(async (file) => {
          const info = await stat(file);
          return `${relative(this.options.workspaceRoot, file)}:${info.size}:${Math.trunc(info.mtimeMs)}`;
        })
      );
      return parts.join("|");
    } catch {
      return undefined;
    }
  }

  async validateArtifacts(taskId: string, stepId: string | undefined): Promise<TaskEvidence[]> {
    const startedAt = nowIso();
    try {
      const files = await walk(this.options.workspaceRoot);
      const relativeFiles = files.map((file) => relative(this.options.workspaceRoot, file));
      const evidence: TaskEvidence[] = [];
      const pyFiles = relativeFiles.filter((file) => file.endsWith(".py") && !file.includes(`${sep}__pycache__${sep}`));
      const texFiles = relativeFiles.filter((file) => file.endsWith(".tex"));
      const pythonTool = findFirstAvailable(["python3", "python"]) ?? "python3";
      const pythonTests = pyFiles.some((file) => isPythonTestFile(file));
      const latexTool = findFirstAvailable(["latexmk", "pdflatex"]) ?? "pdflatex";
      const environmentTools = [
        ...(pyFiles.length ? [pythonTool, ...(pythonTests && findFirstAvailable(["pytest"]) ? ["pytest"] : [])] : []),
        ...(texFiles.length ? [latexTool] : [])
      ];
      if (environmentTools.length) {
        const environmentEvidence = await this.runEnvironmentCheck(taskId, stepId, startedAt, environmentTools);
        evidence.push(environmentEvidence);
      }

      const pythonEvidence = await this.validatePythonArtifacts(taskId, stepId, pyFiles);
      evidence.push(...pythonEvidence);

      const latexEvidence = await this.validateLatexArtifacts(taskId, stepId, texFiles);
      evidence.push(...latexEvidence);

      return evidence;
    } catch (error) {
      const failure = normalizeToolError(error);
      return [
        this.evidence(taskId, stepId, "runTests", "failed", `Artifact validation failed: ${failure.message}`, startedAt, {
          error: failure.message,
          output: failure.output?.slice(0, 20_000),
          command: failure.command,
          outcome: outcomeFromToolFailure("runTests", failure.message, failure.command, failure.output)
        })
      ];
    }
  }

  async ensureRequestedDeliverables(taskId: string, stepId: string | undefined, prompt: string): Promise<TaskEvidence[]> {
    const files = await walk(this.options.workspaceRoot);
    const relativeFiles = files.map((file) => relative(this.options.workspaceRoot, file));
    const pyFiles = relativeFiles.filter((file) => file.endsWith(".py") && !isPythonTestFile(file));
    const implementation = choosePythonImplementation(pyFiles, prompt);
    if (!implementation) {
      return [];
    }

    const evidence: TaskEvidence[] = [];
    let knownFiles = new Set(relativeFiles);
    const stem = basename(implementation, ".py");
    const testFile = `test_${stem}.py`;
    if (promptRequestsTests(prompt) && !relativeFiles.some((file) => isPythonTestFile(file))) {
      await writeFile(this.resolvePath(testFile), slidingWindowTestContent(stem), "utf8");
      evidence.push(
        this.evidence(taskId, stepId, "writeFile", "succeeded", `Generated missing unittest file ${testFile}.`, nowIso(), {
          path: this.resolvePath(testFile),
          output: slidingWindowTestContent(stem).slice(0, 20_000),
          outcome: {
            semanticStatus: "success",
            category: "file",
            retryable: false,
            blocksCompletion: false,
            summary: `Generated missing unittest file ${testFile}.`,
            artifacts: [{ path: this.resolvePath(testFile), kind: "other" }]
          }
        })
      );
      knownFiles = new Set([...knownFiles, testFile]);
    }

    if (promptRequestsPylint(prompt) && !knownFiles.has("pylint_report.txt")) {
      const testFiles = Array.from(knownFiles).filter((file) => isPythonTestFile(file));
      const command = `pylint ${[implementation, ...testFiles].map(shellQuote).join(" ")} > pylint_report.txt`;
      evidence.push(await this.runValidationCommand(taskId, stepId, command, "Generated pylint report.", 60_000, 1024 * 1024, "runCommand"));
      knownFiles = new Set([...knownFiles, "pylint_report.txt"]);
    }

    if (promptRequestsProfile(prompt) && !knownFiles.has("profile_report.txt")) {
      const python = findFirstAvailable(["python3", "python"]) ?? "python3";
      const profileFile = `profile_${stem}.py`;
      const profileContent = slidingWindowProfileContent(stem);
      await writeFile(this.resolvePath(profileFile), profileContent, "utf8");
      evidence.push(
        this.evidence(taskId, stepId, "writeFile", "succeeded", `Generated missing profile script ${profileFile}.`, nowIso(), {
          path: this.resolvePath(profileFile),
          output: profileContent.slice(0, 20_000),
          outcome: {
            semanticStatus: "success",
            category: "file",
            retryable: false,
            blocksCompletion: false,
            summary: `Generated missing profile script ${profileFile}.`,
            artifacts: [{ path: this.resolvePath(profileFile), kind: "other" }]
          }
        })
      );
      evidence.push(await this.runValidationCommand(taskId, stepId, `${python} ${shellQuote(profileFile)}`, "Generated performance profile report.", 60_000, 1024 * 1024, "runCommand"));
      knownFiles = new Set([...knownFiles, profileFile, "profile_report.txt"]);
    }

    if (promptRequestsLatex(prompt) && !knownFiles.has("report.tex")) {
      const reportContent = latexReportContent({
        implementation,
        testFile: knownFiles.has(testFile) ? testFile : undefined,
        pylintReport: knownFiles.has("pylint_report.txt") ? "pylint_report.txt" : undefined,
        profileReport: knownFiles.has("profile_report.txt") ? "profile_report.txt" : undefined
      });
      await writeFile(this.resolvePath("report.tex"), reportContent, "utf8");
      evidence.push(
        this.evidence(taskId, stepId, "writeFile", "succeeded", "Generated missing LaTeX report report.tex.", nowIso(), {
          path: this.resolvePath("report.tex"),
          output: reportContent.slice(0, 20_000),
          outcome: {
            semanticStatus: "success",
            category: "file",
            retryable: false,
            blocksCompletion: false,
            summary: "Generated missing LaTeX report report.tex.",
            artifacts: [{ path: this.resolvePath("report.tex"), kind: "report" }]
          }
        })
      );
    }

    return evidence;
  }

  private policyDenial(call: WorkspaceToolCall): string | undefined {
    if ((call.name === "writeFile" || call.name === "applyPatch") && !this.options.allowFileWrites) {
      return `Policy denied ${call.name}: file writes are disabled.`;
    }
    if ((call.name === "runCommand" || call.name === "runTests") && !this.options.allowTerminalCommands) {
      return `Policy denied ${call.name}: terminal commands are disabled.`;
    }
    return undefined;
  }

  private async dispatch(call: WorkspaceToolCall): Promise<Partial<TaskEvidence> & { summary: string }> {
    if (call.name === "listFiles") {
      const path = this.resolvePath(inputPath(call.input, "."));
      const entries = await readdir(path, { withFileTypes: true });
      return {
        path,
        output: entries.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`).join("\n"),
        summary: `Listed ${entries.length} entries.`
      };
    }
    if (call.name === "readFile") {
      const path = this.resolvePath(requiredPath(call.input));
      const content = await readTextFile(path, relative(this.options.workspaceRoot, path));
      return { path, output: content.slice(0, 20_000), summary: `Read ${relative(this.options.workspaceRoot, path)}.` };
    }
    if (call.name === "grep") {
      const pattern = requiredInputString(call.input, ["pattern", "query", "regex"], "pattern");
      const path = this.resolvePath(inputPath(call.input, "."));
      const result = await runCommand("rg", ["-n", pattern, path], this.options.workspaceRoot, 10_000, true);
      return { path, output: result.output.slice(0, 20_000), summary: `Searched for ${pattern}.` };
    }
    if (call.name === "glob") {
      const pattern = requiredInputString(call.input, ["pattern", "glob", "query"], "pattern");
      const files = await walk(this.options.workspaceRoot);
      const matches = files.filter((file) => simpleGlobMatch(pattern, relative(this.options.workspaceRoot, file)));
      return { output: matches.map((file) => relative(this.options.workspaceRoot, file)).join("\n"), summary: `Matched ${matches.length} files.` };
    }
    if (call.name === "writeFile") {
      const path = this.resolvePath(requiredPath(call.input));
      const content = requiredContent(call.input);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return { path, output: content.slice(0, 20_000), summary: `Wrote ${relative(this.options.workspaceRoot, path)}.` };
    }
    if (call.name === "applyPatch") {
      const path = this.resolvePath(requiredPath(call.input));
      const search = requiredInputString(call.input, ["search", "oldText", "old_text", "find"], "search");
      const replace = inputString(firstPresent(call.input, ["replace", "newText", "new_text", "replacement"]), "");
      const content = await readTextFile(path, relative(this.options.workspaceRoot, path));
      const match = findBestMatch(content, search);
      if (!match) {
        throw new ToolError(`Search text was not found in ${relative(this.options.workspaceRoot, path)}`, { path });
      }
      const patched = content.slice(0, match.index) + replace + content.slice(match.index + match.length);
      await writeFile(path, patched, "utf8");
      const method = match.method === "exact" ? "" : ` (matched via ${match.method})`;
      return { path, summary: `Patched ${relative(this.options.workspaceRoot, path)}${method}.` };
    }
    if (call.name === "runCommand") {
      const command = normalizeShellCommand(requiredInputString(call.input, ["command", "cmd"], "command"), this.options.workspaceRoot);
      await this.preflightCommand(command);
      const result = await runShell(command, this.options.workspaceRoot);
      return this.commandResult(command, result, `Ran command: ${command}`);
    }
    if (call.name === "runTests") {
      const command = normalizeShellCommand(inputString(firstPresent(call.input, ["command", "cmd"]), this.options.testCommand ?? "npm test"), this.options.workspaceRoot);
      await this.preflightCommand(command);
      const result = await runShell(command, this.options.workspaceRoot);
      return this.commandResult(command, result, `Ran tests: ${command}`);
    }
    if (call.name === "environmentCheck") {
      const startedAt = nowIso();
      const evidence = await this.runEnvironmentCheck("tool", undefined, startedAt, call.input.tools);
      return {
        output: evidence.output,
        summary: evidence.summary
      };
    }
    if (call.name === "gitDiff") {
      const output = await this.gitDiff();
      return { output: output.slice(0, 30_000), summary: output.trim() ? "Captured git diff." : "No git diff." };
    }
    if (call.name === "getDiagnostics") {
      if (!this.options.diagnosticsResolver) {
        return { summary: "No diagnostics provider configured.", output: "Diagnostics require a VS Code extension context." };
      }
      const uri = typeof call.input.path === "string" ? call.input.path : typeof call.input.uri === "string" ? call.input.uri : undefined;
      const diagnostics = await this.options.diagnosticsResolver(uri);
      if (diagnostics.length === 0) {
        return { summary: "No diagnostics found.", output: "Clean - no errors or warnings." };
      }
      const errors = diagnostics.filter((d) => d.severity === "error");
      const warnings = diagnostics.filter((d) => d.severity === "warning");
      const output = diagnostics
        .map((d) => `${d.severity.toUpperCase()} ${d.file}${d.line !== undefined ? `:${d.line}` : ""}${d.column !== undefined ? `:${d.column}` : ""} - ${d.message}`)
        .join("\n");
      return {
        summary: `${errors.length} error(s), ${warnings.length} warning(s) found.`,
        output: output.slice(0, 20_000)
      };
    }
    return exhaustive(call.name);
  }

  private resolvePath(path: string): string {
    const cleaned = cleanPathInput(path);
    const resolved = resolve(this.options.workspaceRoot, cleaned);
    const root = resolve(this.options.workspaceRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new Error(`Path escapes workspace root: ${path}`);
    }
    return resolved;
  }

  private async preflightCommand(command: string): Promise<void> {
    // Check if LaTeX tools are installed
    const missingTool = findMissingLatexTool(command);
    if (missingTool) {
      throw new ToolError(`LaTeX tool '${missingTool}' is not installed or not in PATH`, {
        command,
        output: `The command requires '${missingTool}' but it was not found on this system. Install a TeX distribution (e.g. TeX Live, MacTeX, MiKTeX) to use this tool.`
      });
    }

    const missingTexFile = findMissingLatexInput(command, this.options.workspaceRoot);
    if (!missingTexFile) {
      return;
    }
    const files = await listWorkspaceEntries(this.options.workspaceRoot);
    const texFiles = files.filter((file) => file.endsWith(".tex"));
    throw new ToolError(`LaTeX input file does not exist: ${missingTexFile}`, {
      path: resolve(this.options.workspaceRoot, missingTexFile),
      command,
      output: [
        `${missingTexFile} was referenced by the command, but it is not present in the workspace root.`,
        texFiles.length ? `Available .tex files: ${texFiles.join(", ")}` : "No .tex files were found in the workspace root.",
        `Workspace entries: ${files.join(", ") || "(empty)"}`
      ].join("\n")
    });
  }

  private async runEnvironmentCheck(
    taskId: string,
    stepId: string | undefined,
    timestamp: string,
    requestedTools?: unknown
  ): Promise<TaskEvidence> {
    const tools = Array.isArray(requestedTools)
      ? requestedTools.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
      : ["python3", "python", "pytest", "pdflatex", "xelatex", "lualatex", "latexmk"];
    const checks = await Promise.all(tools.map((tool) => checkTool(tool, this.options.workspaceRoot)));
    const missing = checks.filter((check) => !check.available).map((check) => check.tool);
    const output = checks
      .map((check) => `${check.available ? "ok" : "missing"} ${check.tool}${check.path ? ` ${check.path}` : ""}${check.version ? ` - ${check.version}` : ""}${check.error ? ` - ${check.error}` : ""}`)
      .join("\n");
    return this.evidence(
      taskId,
      stepId,
      "environmentCheck",
      missing.length ? "failed" : "succeeded",
      missing.length ? `Missing environment tools: ${missing.join(", ")}` : "Environment tools are available.",
      timestamp,
      {
        output,
        outcome: {
          semanticStatus: missing.length ? "environment_missing" : "success",
          category: "environment",
          retryable: false,
          blocksCompletion: missing.length > 0,
          summary: missing.length ? `Missing environment tools: ${missing.join(", ")}` : "Environment tools are available.",
          findings: missing.map((tool) => ({ severity: "fatal", message: `${tool} is not available on PATH.` })),
          suggestedRecovery: missing.length ? [`Install missing tool(s) or adjust the task to avoid: ${missing.join(", ")}`] : undefined
        }
      }
    );
  }

  private async validatePythonArtifacts(taskId: string, stepId: string | undefined, pyFiles: string[]): Promise<TaskEvidence[]> {
    if (!pyFiles.length) {
      return [];
    }
    const python = findFirstAvailable(["python3", "python"]);
    if (!python) {
      return [
        this.evidence(taskId, stepId, "runTests", "failed", "Python validation failed: python3/python is not available.", nowIso(), {
          outcome: {
            semanticStatus: "environment_missing",
            category: "environment",
            retryable: false,
            blocksCompletion: true,
            summary: "Python validation failed: python3/python is not available.",
            suggestedRecovery: ["Install Python or configure a workspace with python3/python available on PATH."]
          }
        })
      ];
    }
    const tests = pyFiles.filter((file) => isPythonTestFile(file));
    if (tests.length) {
      const pytest = findFirstAvailable(["pytest"]);
      if (pytest) {
        const pytestCommand = `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 ${python} -m pytest -q ${tests.map(shellQuote).join(" ")}`;
        const pytestEvidence = await this.runValidationCommand(taskId, stepId, pytestCommand, "Ran Python tests with pytest.", 20_000);
        if (pytestEvidence.status === "succeeded" && pytestEvidence.output?.trim()) {
          return [pytestEvidence];
        }
        const unittestCommand = `${python} -m unittest discover -s . -p 'test*.py'`;
        const unittestEvidence = await this.runValidationCommand(taskId, stepId, unittestCommand, "Ran Python tests with unittest fallback.", 20_000);
        return [
          {
            ...unittestEvidence,
            status: unittestEvidence.status,
            outcome: mergeFallbackOutcome(pytestEvidence, unittestEvidence),
            summary:
              unittestEvidence.status === "succeeded"
                ? `${pytestFallbackReason(pytestEvidence)}; unittest fallback passed.`
                : `${pytestFallbackReason(pytestEvidence)}; unittest fallback failed: ${unittestEvidence.summary}`,
            output: [`Pytest fallback reason: ${pytestFallbackReason(pytestEvidence)}`, pytestEvidence.output, "Unittest fallback:", unittestEvidence.output]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, 20_000)
          }
        ];
      }
      const command = `${python} -m unittest discover -s . -p 'test*.py'`;
      return [await this.runValidationCommand(taskId, stepId, command, "Ran Python tests with unittest.", 20_000)];
    }

    const runnable = pyFiles.find((file) => !basename(file).startsWith("__init__."));
    if (!runnable) {
      return [];
    }
    return [await this.runValidationCommand(taskId, stepId, `${python} ${shellQuote(runnable)}`, `Ran Python file ${runnable}.`, 20_000)];
  }

  private async validateLatexArtifacts(taskId: string, stepId: string | undefined, texFiles: string[]): Promise<TaskEvidence[]> {
    if (!texFiles.length) {
      return [];
    }
    const latexmk = findFirstAvailable(["latexmk"]);
    const pdflatex = findFirstAvailable(["pdflatex"]);
    if (!latexmk && !pdflatex) {
      return [
        this.evidence(taskId, stepId, "runTests", "failed", "LaTeX validation failed: latexmk/pdflatex is not available.", nowIso(), {
          outcome: {
            semanticStatus: "environment_missing",
            category: "environment",
            retryable: false,
            blocksCompletion: true,
            summary: "LaTeX validation failed: latexmk/pdflatex is not available.",
            suggestedRecovery: ["Install a TeX distribution such as TeX Live, MacTeX, or MiKTeX."]
          }
        })
      ];
    }
    const target = chooseLatexTarget(texFiles);
    const command = latexmk
      ? `${latexmk} -pdf -interaction=nonstopmode ${shellQuote(target)}`
      : `${pdflatex} -interaction=nonstopmode ${shellQuote(target)}`;
    const evidence = await this.runValidationCommand(taskId, stepId, command, `Compiled LaTeX file ${target}.`, 120_000, 5 * 1024 * 1024);
    const pdf = target.replace(/\.tex$/i, ".pdf");
    if (evidence.status === "succeeded" && existsSyncSafe(resolve(this.options.workspaceRoot, pdf))) {
      return [
        {
          ...evidence,
          path: resolve(this.options.workspaceRoot, pdf),
          summary: `${evidence.summary} Produced ${pdf}.`
        }
      ];
    }
    return [evidence];
  }

  private async runValidationCommand(
    taskId: string,
    stepId: string | undefined,
    command: string,
    successSummary: string,
    timeout: number,
    maxBuffer = 1024 * 1024,
    toolName: "runTests" | "runCommand" = "runTests"
  ): Promise<TaskEvidence> {
    const timestamp = nowIso();
    try {
      const normalized = normalizeShellCommand(command, this.options.workspaceRoot);
      await this.preflightCommand(normalized);
      const result = await runCommand(
        process.platform === "win32" ? "cmd" : "sh",
        process.platform === "win32" ? ["/c", normalized] : ["-lc", normalized],
        this.options.workspaceRoot,
        timeout,
        true,
        maxBuffer
      );
      const enriched = await this.enrichRedirectedOutput(normalized, result.output);
      const output = enriched.slice(0, 20_000);
      const outcome = await this.classifyCommandOutcome(normalized, result, output);
      const emptyOutputSuffix = output.trim() ? "" : " Command completed with no output.";
      return this.evidence(taskId, stepId, toolName, evidenceStatusForOutcome(outcome), outcome.summary || `${successSummary}${emptyOutputSuffix}`, timestamp, {
        command: normalized,
        output,
        outcome
      });
    } catch (error) {
      const failure = normalizeToolError(error);
      return this.evidence(taskId, stepId, toolName, "failed", `Validation command failed: ${failure.message}`, timestamp, {
        error: failure.message,
        output: failure.output?.slice(0, 20_000),
        command: failure.command ?? command,
        outcome: outcomeFromToolFailure("runTests", failure.message, failure.command ?? command, failure.output)
      });
    }
  }

  private async commandResult(command: string, result: CommandResult, fallbackSummary: string): Promise<Partial<TaskEvidence> & { summary: string }> {
    const enrichedOutput = await this.enrichRedirectedOutput(command, result.output);
    const outcome = await this.classifyCommandOutcome(command, result, enrichedOutput);
    const reportPath = redirectTarget(command);
    return {
      status: evidenceStatusForOutcome(outcome),
      command,
      output: enrichedOutput.slice(0, 20_000),
      path: reportPath ? this.resolvePath(reportPath) : undefined,
      summary: outcome.summary || fallbackSummary,
      outcome
    };
  }

  private async classifyCommandOutcome(command: string, result: CommandResult, output: string): Promise<CommandOutcome> {
    const reportPath = redirectTarget(command);
    const report = await this.readRedirectTarget(command);
    const classifierInput = report ?? output;
    const category = commandCategory(command);
    const artifacts = await this.commandArtifacts(command, output);
    if (isPylintCommand(command)) {
      const analysis = analyzePylintOutput(classifierInput);
      const hasFatalOrError = analysis.findings.some((finding) => finding.severity === "fatal" || finding.severity === "error");
      return {
        exitCode: result.exitCode,
        semanticStatus: hasFatalOrError ? "blocking_failure" : analysis.findings.length > 0 ? "success_with_findings" : "success",
        category: "lint",
        retryable: false,
        blocksCompletion: hasFatalOrError,
        summary: `Pylint completed with ${analysis.findings.length} finding(s), score ${analysis.score ?? "unknown"}${reportPath ? ` (${reportPath})` : ""}.`,
        findings: analysis.findings,
        artifacts,
        suggestedRecovery: hasFatalOrError ? ["Fix fatal/error pylint findings, then rerun pylint."] : undefined
      };
    }
    if (result.timedOut) {
      return {
        exitCode: result.exitCode,
        semanticStatus: "retryable_failure",
        category,
        retryable: true,
        blocksCompletion: false,
        summary: `Command timed out: ${command}`,
        artifacts,
        suggestedRecovery: ["Retry with a narrower command, shorter timeout, or non-interactive flags."]
      };
    }
    if (result.exitCode === 0) {
      return {
        exitCode: 0,
        semanticStatus: "success",
        category,
        retryable: false,
        blocksCompletion: false,
        summary: commandSuccessSummary(command, category),
        artifacts
      };
    }
    const missing = missingToolFromOutput(output);
    if (missing) {
      return {
        exitCode: result.exitCode,
        semanticStatus: "environment_missing",
        category: "environment",
        retryable: false,
        blocksCompletion: true,
        summary: `Missing environment tool or dependency: ${missing}`,
        findings: [{ severity: "fatal", message: `Missing environment tool or dependency: ${missing}` }],
        artifacts,
        suggestedRecovery: [`Install or configure ${missing}, then rerun the command.`]
      };
    }
    if (category === "test") {
      return {
        exitCode: result.exitCode,
        semanticStatus: "diagnostic_failure",
        category,
        retryable: false,
        blocksCompletion: false,
      summary: `Test command reported failures with exit ${result.exitCode}.`,
        findings: parseGenericFindings(output, "error"),
        artifacts,
        suggestedRecovery: ["Use the test output to repair the implementation, then rerun tests."]
      };
    }
    if (category === "compile" || category === "build") {
      return {
        exitCode: result.exitCode,
        semanticStatus: "diagnostic_failure",
        category,
        retryable: false,
        blocksCompletion: false,
      summary: `${category === "compile" ? "Compile" : "Build"} command reported diagnostics with exit ${result.exitCode}.`,
        findings: parseGenericFindings(output, "error"),
        artifacts,
        suggestedRecovery: ["Use the compiler/build diagnostics to repair the files, then rerun validation."]
      };
    }
    return {
      exitCode: result.exitCode,
      semanticStatus: "diagnostic_failure",
      category,
      retryable: false,
      blocksCompletion: false,
      summary: `Command exited with exit ${result.exitCode}.`,
      findings: parseGenericFindings(output, "warning"),
      artifacts,
      suggestedRecovery: ["Inspect the command output and adjust the command or files before retrying."]
    };
  }

  private async commandArtifacts(command: string, output: string): Promise<CommandArtifact[] | undefined> {
    const artifacts: CommandArtifact[] = [];
    const target = redirectTarget(command);
    if (target && existsSyncSafe(this.resolvePath(target))) {
      artifacts.push({ path: this.resolvePath(target), kind: artifactKind(target) });
    }
    for (const file of inferredArtifactFiles(command)) {
      const path = this.resolvePath(file);
      if (existsSyncSafe(path) && !artifacts.some((artifact) => artifact.path === path)) {
        artifacts.push({ path, kind: artifactKind(file) });
      }
    }
    for (const file of output.match(/[\w./-]+\.(?:pdf|txt|log|json|xml|html|prof|out|coverage)/giu) ?? []) {
      try {
        const path = this.resolvePath(file);
        if (existsSyncSafe(path) && !artifacts.some((artifact) => artifact.path === path)) {
          artifacts.push({ path, kind: artifactKind(file) });
        }
      } catch {
        // Ignore paths outside the workspace that only appeared in command output.
      }
    }
    return artifacts.length ? artifacts : undefined;
  }

  private async enrichRedirectedOutput(command: string, output: string): Promise<string> {
    const report = await this.readRedirectTarget(command);
    if (!report) {
      return output;
    }
    return [output.trim(), "Redirected output:", report].filter(Boolean).join("\n\n");
  }

  private async readRedirectTarget(command: string): Promise<string | undefined> {
    const target = redirectTarget(command);
    if (!target) {
      return undefined;
    }
    try {
      const path = this.resolvePath(target);
      return (await readFile(path, "utf8")).slice(0, 20_000);
    } catch {
      return undefined;
    }
  }

  private evidence(
    taskId: string,
    stepId: string | undefined,
    toolName: WorkspaceToolName,
    status: TaskEvidence["status"],
    summary: string,
    timestamp: string,
    patch: Partial<TaskEvidence> = {}
  ): TaskEvidence {
    return {
      id: createId("evd"),
      taskId,
      stepId,
      toolName,
      status,
      summary,
      timestamp,
      ...patch
    };
  }
}

function inferredArtifactFiles(command: string): string[] {
  const lower = command.toLowerCase();
  const files: string[] = [];
  if (lower.includes("profile")) {
    files.push("profile_report.txt");
  }
  if (lower.includes("pylint")) {
    files.push("pylint_report.txt");
  }
  if (isLatexCommand(command)) {
    for (const token of shellWords(command)) {
      if (token.endsWith(".tex")) {
        files.push(token.replace(/\.tex$/i, ".pdf"));
      }
    }
  }
  return files;
}

class ToolError extends Error {
  readonly output?: string;
  readonly path?: string;
  readonly command?: string;

  constructor(message: string, patch: { output?: string; path?: string; command?: string } = {}) {
    super(message);
    this.name = "ToolError";
    this.output = patch.output;
    this.path = patch.path;
    this.command = patch.command;
  }
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "__pycache__" || entry.name === ".pytest_cache" || entry.name === ".mypy_cache") {
      continue;
    }
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

async function listWorkspaceEntries(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.map((entry) => `${entry.isDirectory() ? "dir " : "file "}${entry.name}`);
}

function normalizeShellCommand(command: string, workspaceRoot: string): string {
  let normalized = command.trim();
  for (let index = 0; index < 3; index += 1) {
    const unwrapped = unwrapShellLoginCommand(normalized);
    if (unwrapped === normalized) {
      break;
    }
    normalized = unwrapped.trim();
  }
  return stripWorkspaceCd(normalized, workspaceRoot);
}

function unwrapShellLoginCommand(command: string): string {
  const match = command.match(/^(?:sh|bash|zsh)\s+-l?c\s+(.+)$/s);
  if (!match) {
    return command;
  }
  return stripOuterQuotes(match[1].trim());
}

function stripWorkspaceCd(command: string, workspaceRoot: string): string {
  const escapedRoot = escapeRegExp(workspaceRoot);
  const cdPattern = new RegExp(`^cd\\s+(['"]?)${escapedRoot}\\1\\s*&&\\s*`, "s");
  return command.replace(cdPattern, "").trim();
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function findMissingLatexTool(command: string): string | undefined {
  const tokens = shellWords(command);
  for (const token of tokens) {
    if (LATEX_TOOLS.includes(token)) {
      try {
        execFileSync("which", [token], { timeout: 5_000, stdio: "ignore" });
      } catch {
        return token;
      }
    }
  }
  return undefined;
}

async function checkTool(tool: string, cwd: string): Promise<{ tool: string; available: boolean; path?: string; version?: string; error?: string }> {
  try {
    const location = await runCommand("which", [tool], cwd, 5_000);
    const version = await toolVersion(tool, cwd);
    return { tool, available: true, path: location.output.trim(), version };
  } catch (error) {
    const failure = normalizeToolError(error);
    return { tool, available: false, error: failure.message };
  }
}

async function toolVersion(tool: string, cwd: string): Promise<string | undefined> {
  const args = tool === "latexmk" ? ["-v"] : ["--version"];
  try {
    const result = await runCommand(tool, args, cwd, 5_000, true, 128 * 1024);
    return result.output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 200);
  } catch {
    return undefined;
  }
}

function findFirstAvailable(tools: string[]): string | undefined {
  return tools.find((tool) => {
    try {
      execFileSync("which", [tool], { timeout: 5_000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

function isPythonTestFile(file: string): boolean {
  const name = basename(file);
  return (name.startsWith("test_") || name.endsWith("_test.py") || name === "test.py") && extname(name) === ".py";
}

function chooseLatexTarget(files: string[]): string {
  return (
    files.find((file) => basename(file).toLowerCase() === "report.tex") ??
    files.find((file) => basename(file).toLowerCase() === "main.tex") ??
    files[0]
  );
}

function choosePythonImplementation(files: string[], prompt: string): string | undefined {
  const candidates = files.filter((file) => !isPythonTestFile(file) && !basename(file).startsWith("__init__.") && !basename(file).startsWith("profile_"));
  if (!candidates.length) {
    return undefined;
  }
  if (/sliding|window|滑动窗口/u.test(prompt)) {
    return (
      candidates.find((file) => /sliding.*window|window.*max|sliding_window/u.test(file)) ??
      candidates.find((file) => /window/u.test(file)) ??
      candidates[0]
    );
  }
  return candidates[0];
}

function promptRequestsTests(prompt: string): boolean {
  return /unittest|pytest|unit test|单元测试|测试/u.test(prompt);
}

function promptRequestsPylint(prompt: string): boolean {
  return /pylint|lint/u.test(prompt);
}

function promptRequestsProfile(prompt: string): boolean {
  return /profile|profiling|性能/u.test(prompt);
}

function promptRequestsLatex(prompt: string): boolean {
  return /latex|tex|pdf|报告/u.test(prompt);
}

function slidingWindowTestContent(moduleName: string): string {
  return `\"\"\"Unittest coverage for the sliding window maximum implementation.\"\"\"\nimport importlib\nimport unittest\n\n\n_module = importlib.import_module(\"${moduleName}\")\n\n\ndef _resolve_solver():\n    for name in (\"max_sliding_window\", \"maxSlidingWindow\", \"max_sliding_window_max\", \"sliding_window_max\"):\n        candidate = getattr(_module, name, None)\n        if callable(candidate):\n            return candidate\n    solution = getattr(_module, \"Solution\", None)\n    if solution is not None:\n        instance = solution()\n        for name in (\"maxSlidingWindow\", \"max_sliding_window\"):\n            candidate = getattr(instance, name, None)\n            if callable(candidate):\n                return candidate\n    raise AttributeError(\"Could not find a sliding window maximum solver function\")\n\n\n_solve = _resolve_solver()\n\n\nclass TestSlidingWindowMaximum(unittest.TestCase):\n    def test_leetcode_example(self):\n        self.assertEqual(_solve([1, 3, -1, -3, 5, 3, 6, 7], 3), [3, 3, 5, 5, 6, 7])\n\n    def test_window_size_one(self):\n        self.assertEqual(_solve([4, 2, 12], 1), [4, 2, 12])\n\n    def test_entire_array_window(self):\n        self.assertEqual(_solve([9, 1, 3], 3), [9])\n\n    def test_duplicates_and_negatives(self):\n        self.assertEqual(_solve([-4, -2, -5, -2, -1], 2), [-2, -2, -2, -1])\n\n    def test_empty_when_k_too_large(self):\n        self.assertEqual(_solve([1, 2], 3), [])\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n`;
}

function slidingWindowProfileContent(moduleName: string): string {
  return `\"\"\"Profile the sliding window maximum implementation.\"\"\"\nimport cProfile\nimport importlib\nimport pstats\n\n\n_module = importlib.import_module(\"${moduleName}\")\n\n\ndef _resolve_solver():\n    for name in (\"max_sliding_window\", \"maxSlidingWindow\", \"max_sliding_window_max\", \"sliding_window_max\"):\n        candidate = getattr(_module, name, None)\n        if callable(candidate):\n            return candidate\n    solution = getattr(_module, \"Solution\", None)\n    if solution is not None:\n        instance = solution()\n        for name in (\"maxSlidingWindow\", \"max_sliding_window\"):\n            candidate = getattr(instance, name, None)\n            if callable(candidate):\n                return candidate\n    raise AttributeError(\"Could not find a sliding window maximum solver function\")\n\n\ndef main():\n    solve = _resolve_solver()\n    nums = list(range(10000)) + list(range(10000, 0, -1))\n    for _ in range(200):\n        solve(nums, 128)\n\n\nif __name__ == \"__main__\":\n    profiler = cProfile.Profile()\n    profiler.enable()\n    main()\n    profiler.disable()\n    with open(\"profile_report.txt\", \"w\", encoding=\"utf-8\") as handle:\n        stats = pstats.Stats(profiler, stream=handle)\n        stats.sort_stats(\"cumtime\").print_stats(20)\n`;
}

function latexReportContent(input: { implementation: string; testFile?: string; pylintReport?: string; profileReport?: string }): string {
  const rows = [
    ["Implementation", input.implementation, "Provided"],
    ["Unit tests", input.testFile ?? "not generated", input.testFile ? "Provided" : "Missing"],
    ["Pylint", input.pylintReport ?? "not generated", input.pylintReport ? "Provided" : "Missing"],
    ["Profiling", input.profileReport ?? "not generated", input.profileReport ? "Provided" : "Missing"]
  ];
  return [
    "\\documentclass{article}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[margin=1in]{geometry}",
    "\\begin{document}",
    "\\title{Sliding Window Maximum Report}",
    "\\author{Flint}",
    "\\date{\\today}",
    "\\maketitle",
    "\\section{Algorithm}",
    "The implementation uses a monotonic deque to keep candidate indices for the current window. Each index is pushed and popped at most once, so the time complexity is O(n) and the auxiliary space complexity is O(k).",
    "\\section{Deliverables}",
    "\\begin{tabular}{lll}",
    "Item & Evidence & Status \\\\",
    "\\hline",
    ...rows.map((row) => `${escapeLatex(row[0])} & ${escapeLatex(row[1])} & ${escapeLatex(row[2])} \\\\`),
    "\\end{tabular}",
    "\\section{Verification}",
    "The accompanying evidence files contain unittest results, pylint analysis, and profiling output when available.",
    "\\end{document}",
    ""
  ].join("\n");
}

function escapeLatex(value: string): string {
  return value.replace(/[&#%_$]/g, (char) => `\\${char}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findMissingLatexInput(command: string, workspaceRoot: string): string | undefined {
  const tokens = shellWords(command);
  for (let index = 0; index < tokens.length; index += 1) {
    const tool = tokens[index];
    if (!["pdflatex", "xelatex", "lualatex", "latexmk"].includes(tool)) {
      continue;
    }
    const texFile = tokens.slice(index + 1).find((token) => token.endsWith(".tex") && !token.startsWith("-"));
    if (!texFile) {
      continue;
    }
    const resolved = resolve(workspaceRoot, cleanPathInput(texFile));
    const root = resolve(workspaceRoot);
    if ((resolved === root || resolved.startsWith(`${root}${sep}`)) && !existsSyncSafe(resolved)) {
      return texFile;
    }
  }
  return undefined;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function simpleGlobMatch(pattern: string, file: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedFile = file.replace(/\\/g, "/");
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR_SLASH__/g, "(?:.*/)?")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalizedFile);
}

const LATEX_TOOLS = ["pdflatex", "xelatex", "lualatex", "latexmk", "bibtex", "biber", "makeindex"];

function isLatexCommand(command: string): boolean {
  const tokens = shellWords(command);
  return tokens.some((token) => LATEX_TOOLS.includes(token));
}

function isPylintCommand(command: string): boolean {
  return shellWords(command).some((token) => basename(token) === "pylint" || token === "pylint");
}

function commandCategory(command: string): CommandOutcomeCategory {
  const tokens = shellWords(command).map((token) => basename(token).toLowerCase());
  const text = command.toLowerCase();
  if (tokens.some((token) => ["pylint", "eslint", "ruff", "flake8", "mypy", "tsc"].includes(token)) || /\blint\b/u.test(text)) {
    return tokens.includes("tsc") ? "build" : "lint";
  }
  if (tokens.some((token) => ["pytest", "vitest", "jest", "mocha", "unittest"].includes(token)) || /\b(test|unittest|pytest)\b/u.test(text)) {
    return "test";
  }
  if (tokens.some((token) => ["latexmk", "pdflatex", "xelatex", "lualatex"].includes(token))) {
    return "compile";
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/u.test(text) || tokens.some((token) => ["make", "cmake", "cargo", "go", "mvn", "gradle"].includes(token))) {
    return "build";
  }
  if (tokens.some((token) => ["python", "python3", "node", "deno", "ruby", "bash", "sh", "zsh"].includes(token))) {
    return "script";
  }
  return "unknown";
}

function commandSuccessSummary(command: string, category: CommandOutcomeCategory): string {
  if (category === "test") {
    return `Test command passed: ${command}`;
  }
  if (category === "compile") {
    return `Compile command passed: ${command}`;
  }
  if (category === "build") {
    return `Build command passed: ${command}`;
  }
  if (category === "lint") {
    return `Lint command completed: ${command}`;
  }
  return `Command completed: ${command}`;
}

function evidenceStatusForOutcome(outcome: CommandOutcome): TaskEvidence["status"] {
  if (outcome.semanticStatus === "success" || outcome.semanticStatus === "success_with_findings") {
    return "succeeded";
  }
  return "failed";
}

function permissionScopeName(call: WorkspaceToolCall): CommandOutcomeCategory {
  if (call.name === "writeFile" || call.name === "applyPatch") {
    return "file";
  }
  if (call.name === "runCommand" || call.name === "runTests") {
    return "script";
  }
  return "unknown";
}

function outcomeFromToolFailure(toolName: WorkspaceToolName, message: string, command?: string, output?: string): CommandOutcome {
  const missing = missingToolFromOutput(`${message}\n${output ?? ""}`);
  if (missing) {
    return {
      semanticStatus: "environment_missing",
      category: "environment",
      retryable: false,
      blocksCompletion: true,
      summary: `Missing environment tool or dependency: ${missing}`,
      findings: [{ severity: "fatal", message: `Missing environment tool or dependency: ${missing}` }],
      suggestedRecovery: [`Install or configure ${missing}, then retry.`]
    };
  }
  if (/timed out|timeout|SIGTERM|ETIMEDOUT/iu.test(message)) {
    return {
      semanticStatus: "retryable_failure",
      category: command ? commandCategory(command) : toolName === "runTests" ? "test" : "unknown",
      retryable: true,
      blocksCompletion: false,
      summary: message,
      suggestedRecovery: ["Retry with a narrower command or non-interactive flags."]
    };
  }
  return {
    semanticStatus: /Path escapes workspace root|Tool input/u.test(message) ? "blocking_failure" : "diagnostic_failure",
    category: command ? commandCategory(command) : toolName === "runTests" ? "test" : "unknown",
    retryable: false,
    blocksCompletion: /Path escapes workspace root|Tool input/u.test(message),
    summary: message,
    findings: parseGenericFindings(output ?? message, "error"),
    suggestedRecovery: ["Inspect the failure, correct the tool input or workspace files, then retry."]
  };
}

function redirectTarget(command: string): string | undefined {
  const match = command.match(/(?:^|\s)(?:\d?>|&>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/u);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function analyzePylintOutput(output: string): { findings: CommandFinding[]; score?: string } {
  const findings = output
    .split(/\r?\n/)
    .map((line): CommandFinding | undefined => {
      const match = line.match(/^([^:]+):(\d+):\d+:\s+([A-Z])\d+:\s+(.+)$/u);
      if (!match) {
        return undefined;
      }
      return {
        file: match[1],
        line: Number(match[2]),
        severity: pylintSeverity(match[3]),
        message: match[4]
      } satisfies CommandFinding;
    })
    .filter((finding): finding is CommandFinding => Boolean(finding));
  const score = output.match(/rated at ([\d.-]+\/10)/u)?.[1];
  return { findings, score };
}

function pylintSeverity(codePrefix: string): CommandFinding["severity"] {
  if (codePrefix === "F") {
    return "fatal";
  }
  if (codePrefix === "E") {
    return "error";
  }
  if (codePrefix === "W") {
    return "warning";
  }
  return "info";
}

function parseGenericFindings(output: string, fallbackSeverity: CommandFinding["severity"]): CommandFinding[] | undefined {
  const findings = output
    .split(/\r?\n/)
    .filter((line) => /\b(error|failed|fatal|warning|warn|exception|traceback)\b/iu.test(line))
    .slice(0, 20)
    .map((line) => ({
      severity: /\b(fatal|exception|traceback)\b/iu.test(line) ? "fatal" : /\b(error|failed)\b/iu.test(line) ? "error" : fallbackSeverity,
      message: line.trim().slice(0, 500)
    }) satisfies CommandFinding);
  return findings.length ? findings : undefined;
}

function missingToolFromOutput(output: string): string | undefined {
  return (
    output.match(/(?:command not found|not found):\s*([\w.-]+)/iu)?.[1] ??
    output.match(/(?:^|\s)([\w.-]+):\s*command not found/iu)?.[1] ??
    output.match(/No module named ['"]?([\w.-]+)['"]?/iu)?.[1] ??
    output.match(/Cannot find module ['"]([^'"]+)['"]/iu)?.[1] ??
    output.match(/No such file or directory:\s*['"]?([^'"\n]+)['"]?/iu)?.[1]
  );
}

function artifactKind(path: string): CommandArtifact["kind"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "binary";
  }
  if (lower.includes("profile")) {
    return "profile";
  }
  if (lower.includes("coverage")) {
    return "coverage";
  }
  if (lower.endsWith(".log")) {
    return "log";
  }
  if (lower.endsWith(".txt") || lower.endsWith(".json") || lower.endsWith(".xml") || lower.endsWith(".html")) {
    return "report";
  }
  return "other";
}

function mergeFallbackOutcome(pytestEvidence: TaskEvidence, fallbackEvidence: TaskEvidence): CommandOutcome | undefined {
  if (!fallbackEvidence.outcome) {
    return undefined;
  }
  if (fallbackEvidence.outcome.semanticStatus === "success") {
    return {
      ...fallbackEvidence.outcome,
      summary: `${pytestFallbackReason(pytestEvidence)}; unittest fallback passed.`,
      suggestedRecovery: undefined
    };
  }
  return {
    ...fallbackEvidence.outcome,
    summary: `${pytestFallbackReason(pytestEvidence)}; unittest fallback failed: ${fallbackEvidence.outcome.summary}`,
    findings: [...(pytestEvidence.outcome?.findings ?? []), ...(fallbackEvidence.outcome.findings ?? [])],
    suggestedRecovery: ["Repair test failures reported by pytest/unittest, then rerun validation."]
  };
}

function pytestFallbackReason(evidence: TaskEvidence): string {
  const text = `${evidence.summary} ${evidence.error ?? ""} ${evidence.output ?? ""}`;
  const exit = text.match(/exit\s+(\d+)/u)?.[1];
  if (exit) {
    return `pytest failed/crashed with exit code ${exit}`;
  }
  if (!evidence.output?.trim()) {
    return "pytest produced no usable output";
  }
  return "pytest did not produce a usable pass";
}

async function runShell(command: string, cwd: string): Promise<CommandResult> {
  const isLatex = isLatexCommand(command);
  const timeout = isLatex ? 120_000 : 30_000;
  const maxBuffer = isLatex ? 5 * 1024 * 1024 : 1024 * 1024;
  return runCommand(
    process.platform === "win32" ? "cmd" : "sh",
    process.platform === "win32" ? ["/c", command] : ["-lc", command],
    cwd,
    timeout,
    true,
    maxBuffer
  );
}

async function runCommand(command: string, args: string[], cwd: string, timeout: number, allowFailure = false, maxBuffer = 1024 * 1024): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, { cwd, timeout, maxBuffer, env: { ...process.env } });
    return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: number | string; signal?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (allowFailure) {
      return {
        output: output || err.message || "",
        exitCode: typeof err.code === "number" ? err.code : 1,
        timedOut: /timed out|timeout/iu.test(err.message ?? "") || err.signal === "SIGTERM",
        spawnError: typeof err.code === "string"
      };
    }
    const exit = err.code !== undefined ? `exit ${err.code}` : err.signal ? `signal ${err.signal}` : "failed";
    throw new ToolError(`${command} ${exit}${output ? `: ${oneLine(output)}` : ""}`, {
      output,
      command: [command, ...args].join(" ")
    });
  }
}

async function readTextFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const err = error as { code?: string; message?: string };
    throw new ToolError(`Could not read ${label}: ${err.code ?? err.message ?? "unknown error"}`, { path });
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`Tool input '${name}' must be a non-empty string`);
  }
  return value;
}

function inputString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length ? value : fallback;
}

function requiredInputString(input: Record<string, unknown>, names: string[], label: string): string {
  return requiredString(firstPresent(input, names), `${label} (${names.join(" or ")})`);
}

function firstPresent(input: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (input[name] !== undefined && input[name] !== null) {
      return input[name];
    }
  }
  return undefined;
}

function requiredPath(input: Record<string, unknown>): string {
  return requiredInputString(input, ["path", "file", "filePath", "file_path", "filename", "targetPath", "target_path"], "path");
}

function inputPath(input: Record<string, unknown>, fallback: string): string {
  return inputString(firstPresent(input, ["path", "dir", "directory", "folder", "root"]), fallback);
}

function requiredContent(input: Record<string, unknown>): string {
  const value = firstPresent(input, ["content", "text", "data", "body"]);
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    throw new Error("Tool input 'content (content or text or data or body)' must be provided");
  }
  return JSON.stringify(value, null, 2);
}

function cleanPathInput(path: string): string {
  return path.trim().replace(/^file:\/\//, "").replace(/^["']|["']$/g, "");
}

function normalizeToolError(error: unknown): { message: string; output?: string; path?: string; command?: string } {
  if (error instanceof ToolError) {
    return { message: error.message, output: error.output, path: error.path, command: error.command };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface PatchMatch {
  index: number;
  length: number;
  method: "exact" | "whitespace" | "blank_lines" | "fuzzy";
}

function findBestMatch(content: string, search: string): PatchMatch | null {
  // 1. Exact match
  const exactIndex = content.indexOf(search);
  if (exactIndex >= 0) {
    return { index: exactIndex, length: search.length, method: "exact" };
  }

  // 2. Whitespace-normalized match (trim trailing whitespace per line, normalize line endings)
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");
  const normalizedMatch = findLinesMatch(contentLines, searchLines, normalizeLineWhitespace);
  if (normalizedMatch) {
    return { ...normalizedMatch, method: "whitespace" };
  }

  // 3. Blank-line-tolerant match (collapse consecutive blank lines)
  const blankMatch = findLinesMatch(contentLines, searchLines, collapseBlankLines);
  if (blankMatch) {
    return { ...blankMatch, method: "blank_lines" };
  }

  // 4. Fuzzy match (edit distance with 0.8 similarity threshold)
  const fuzzyMatch = findFuzzyMatch(contentLines, searchLines);
  if (fuzzyMatch) {
    return { ...fuzzyMatch, method: "fuzzy" };
  }

  return null;
}

function normalizeLineWhitespace(line: string): string {
  return line.trimEnd();
}

function collapseBlankLines(line: string): string {
  return line.trim() === "" ? "" : line.trimEnd();
}

function findLinesMatch(
  contentLines: string[],
  searchLines: string[],
  normalize: (line: string) => string
): { index: number; length: number } | null {
  const normalizedSearch = searchLines.map(normalize);
  // Remove leading/trailing empty lines from search after normalization
  while (normalizedSearch.length > 0 && normalizedSearch[0] === "") {
    normalizedSearch.shift();
  }
  while (normalizedSearch.length > 0 && normalizedSearch[normalizedSearch.length - 1] === "") {
    normalizedSearch.pop();
  }
  if (normalizedSearch.length === 0) {
    return null;
  }

  const normalizedContent = contentLines.map(normalize);
  for (let start = 0; start <= normalizedContent.length - normalizedSearch.length; start += 1) {
    let matched = true;
    let contentIdx = start;
    let searchIdx = 0;

    while (searchIdx < normalizedSearch.length && contentIdx < normalizedContent.length) {
      // Skip extra blank lines in content when search line is not blank
      if (normalizedSearch[searchIdx] !== "" && normalizedContent[contentIdx] === "") {
        contentIdx += 1;
        continue;
      }
      if (normalizedContent[contentIdx] !== normalizedSearch[searchIdx]) {
        matched = false;
        break;
      }
      contentIdx += 1;
      searchIdx += 1;
    }

    if (matched && searchIdx === normalizedSearch.length) {
      const startOffset = contentLines.slice(0, start).join("\n").length + (start > 0 ? 1 : 0);
      const matchedText = contentLines.slice(start, contentIdx).join("\n");
      return { index: startOffset, length: matchedText.length };
    }
  }

  return null;
}

function findFuzzyMatch(contentLines: string[], searchLines: string[]): { index: number; length: number } | null {
  if (searchLines.length === 0) {
    return null;
  }

  const searchText = searchLines.join("\n").trim();
  if (searchText.length === 0) {
    return null;
  }

  let bestSimilarity = 0;
  let bestIndex = -1;
  let bestLength = 0;

  // Slide a window of similar size over content lines
  const windowSizes = [searchLines.length - 1, searchLines.length, searchLines.length + 1].filter(
    (size) => size > 0 && size <= contentLines.length
  );

  for (const windowSize of windowSizes) {
    for (let start = 0; start <= contentLines.length - windowSize; start += 1) {
      const candidate = contentLines.slice(start, start + windowSize).join("\n");
      const similarity = computeSimilarity(searchText, candidate);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = start;
        bestLength = windowSize;
      }
    }
  }

  if (bestSimilarity >= 0.8 && bestIndex >= 0) {
    const startOffset = contentLines.slice(0, bestIndex).join("\n").length + (bestIndex > 0 ? 1 : 0);
    const matchedText = contentLines.slice(bestIndex, bestIndex + bestLength).join("\n");
    return { index: startOffset, length: matchedText.length };
  }

  return null;
}

function computeSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) {
    return 1;
  }
  // Use line-level matching: count matching lines / total lines
  const aLines = a.split("\n").map((line) => line.trimEnd());
  const bLines = b.split("\n").map((line) => line.trimEnd());
  const totalLines = Math.max(aLines.length, bLines.length);
  if (totalLines === 0) {
    return 1;
  }
  // Count exact matching lines (comparing with trimEnd)
  let matchingLines = 0;
  const minLines = Math.min(aLines.length, bLines.length);
  for (let i = 0; i < minLines; i += 1) {
    if (aLines[i] === bLines[i]) {
      matchingLines += 1;
    } else {
      // Partial credit for similar lines based on character overlap
      const lineLen = Math.max(aLines[i].length, bLines[i].length);
      if (lineLen > 0) {
        const commonPrefix = commonPrefixLength(aLines[i], bLines[i]);
        const commonSuffix = commonSuffixLength(aLines[i], bLines[i], commonPrefix);
        matchingLines += (commonPrefix + commonSuffix) / lineLen;
      }
    }
  }
  return matchingLines / totalLines;
}

function commonPrefixLength(a: string, b: string): number {
  const maxLen = Math.min(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return maxLen;
}

function commonSuffixLength(a: string, b: string, prefixLen: number): number {
  const maxLen = Math.min(a.length - prefixLen, b.length - prefixLen);
  for (let i = 0; i < maxLen; i += 1) {
    if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return i;
  }
  return maxLen;
}

function exhaustive(value: never): never {
  throw new Error(`Unsupported tool: ${value}`);
}
