import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceTools } from "./index.js";

let tempDirs: string[] = [];

async function createRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flint-tools-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("WorkspaceTools", () => {
  it("rejects path traversal", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: true });
    const evidence = await tools.execute("task_1", undefined, {
      name: "writeFile",
      input: { path: "../escape.txt", content: "bad" }
    });
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toContain("escapes workspace root");
  });

  it("denies writes when policy disables file writes", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: false });
    const evidence = await tools.execute("task_1", undefined, {
      name: "writeFile",
      input: { path: "a.txt", content: "hello" }
    });
    expect(evidence.status).toBe("denied");
  });

  it("writes and patches files inside the workspace when allowed", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: true });
    await tools.execute("task_1", "step_1", {
      name: "writeFile",
      input: { path: "a.txt", content: "hello" }
    });
    const evidence = await tools.execute("task_1", "step_1", {
      name: "applyPatch",
      input: { path: "a.txt", search: "hello", replace: "hello Flint" }
    });

    expect(evidence.status).toBe("succeeded");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hello Flint");
  });

  it("patches with trailing whitespace differences via whitespace-normalized match", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: true });
    await tools.execute("task_1", "step_1", {
      name: "writeFile",
      input: { path: "ws.txt", content: "line one  \nline two\nline three" }
    });
    const evidence = await tools.execute("task_1", "step_1", {
      name: "applyPatch",
      input: { path: "ws.txt", search: "line one\nline two", replace: "LINE ONE\nLINE TWO" }
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.summary).toContain("whitespace");
    expect(await readFile(join(root, "ws.txt"), "utf8")).toBe("LINE ONE\nLINE TWO\nline three");
  });

  it("patches with extra blank lines via blank-line-tolerant match", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: true });
    await tools.execute("task_1", "step_1", {
      name: "writeFile",
      input: { path: "bl.txt", content: "function foo() {\n\n\n  return 1;\n}" }
    });
    const evidence = await tools.execute("task_1", "step_1", {
      name: "applyPatch",
      input: { path: "bl.txt", search: "function foo() {\n  return 1;\n}", replace: "function foo() {\n  return 2;\n}" }
    });

    expect(evidence.status).toBe("succeeded");
    expect(await readFile(join(root, "bl.txt"), "utf8")).toBe("function foo() {\n  return 2;\n}");
  });

  it("patches with minor character differences via fuzzy match", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: true });
    await tools.execute("task_1", "step_1", {
      name: "writeFile",
      input: { path: "fz.txt", content: "const greeting = 'hello';\nconst name = 'world';\nconsole.log(greeting, name);" }
    });
    const evidence = await tools.execute("task_1", "step_1", {
      name: "applyPatch",
      input: {
        path: "fz.txt",
        search: "const greeting = 'hello';\nconst name = 'wrold';\nconsole.log(greeting, name);",
        replace: "const greeting = 'hi';\nconst name = 'world';\nconsole.log(greeting, name);"
      }
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.summary).toContain("fuzzy");
    expect(await readFile(join(root, "fz.txt"), "utf8")).toBe("const greeting = 'hi';\nconst name = 'world';\nconsole.log(greeting, name);");
  });

  it("accepts common model-generated input aliases", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: true });
    const writeEvidence = await tools.execute("task_1", "step_1", {
      name: "writeFile",
      input: { file_path: "alias.txt", text: "hello aliases" }
    });
    const readEvidence = await tools.execute("task_1", "step_1", {
      name: "readFile",
      input: { filename: "alias.txt" }
    });

    expect(writeEvidence.status).toBe("succeeded");
    expect(readEvidence.status).toBe("succeeded");
    expect(readEvidence.output).toBe("hello aliases");
  });

  it("returns actionable read errors with the requested path", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root });
    const evidence = await tools.execute("task_1", undefined, {
      name: "readFile",
      input: { path: "missing.py" }
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.summary).toContain("Could not read missing.py");
    expect(evidence.path).toContain("missing.py");
    expect(evidence.error).toContain("ENOENT");
  });

  it("denies terminal commands by default", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root });
    const evidence = await tools.execute("task_1", undefined, {
      name: "runCommand",
      input: { command: "echo hello" }
    });
    expect(evidence.status).toBe("denied");
  });

  it("captures terminal failure output when commands are allowed", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.execute("task_1", undefined, {
      name: "runCommand",
      input: { cmd: "printf 'bad output' >&2; exit 7" }
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.summary).toContain("exit 7");
    expect(evidence.output).toContain("bad output");
    expect(evidence.command).toContain("printf");
  });

  it("matches root files with globstar patterns and skips cache directories", async () => {
    const root = await createRoot();
    await writeFile(join(root, "root_file.py"), "print('ok')\n", "utf8");
    await writeFile(join(root, "note.txt"), "hello\n", "utf8");
    await mkdir(join(root, "__pycache__"), { recursive: true });
    await writeFile(join(root, "__pycache__", "cached.pyc"), "", "utf8");
    const tools = new WorkspaceTools({ workspaceRoot: root });
    const pyEvidence = await tools.execute("task_1", undefined, {
      name: "glob",
      input: { pattern: "**/*.py" }
    });
    const allEvidence = await tools.execute("task_1", undefined, {
      name: "glob",
      input: { pattern: "**/*" }
    });

    expect(pyEvidence.status).toBe("succeeded");
    expect(pyEvidence.output).toContain("root_file.py");
    expect(allEvidence.output).toContain("note.txt");
    expect(allEvidence.output).not.toContain("__pycache__");
  });

  it("treats pylint findings with redirected report as completed analysis", async () => {
    if (!commandExists("pylint")) {
      return;
    }
    const root = await createRoot();
    await writeFile(join(root, "lint_target.py"), "import os\n\nprint('hello')\n", "utf8");
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.execute("task_1", undefined, {
      name: "runCommand",
      input: { command: "pylint lint_target.py > pylint_report.txt" }
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.summary).toContain("Pylint completed");
    expect(evidence.summary).toContain("pylint_report.txt");
    expect(evidence.output).toContain("Redirected output");
    expect(evidence.output).toContain("lint_target.py");
  });

  it("normalizes nested shell commands before execution", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.execute("task_1", undefined, {
      name: "runCommand",
      input: { command: `sh -lc 'cd ${root} && echo normalized'` }
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.command).toBe("echo normalized");
    expect(evidence.output).toContain("normalized");
  });

  it("preflights missing LaTeX input files and returns workspace entries", async () => {
    const root = await createRoot();
    await writeFile(join(root, "paper.tex"), "\\documentclass{article}", "utf8");
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.execute("task_1", undefined, {
      name: "runCommand",
      input: { command: `sh -lc 'cd ${root} && pdflatex -interaction=nonstopmode report.tex 2>&1 || xelatex -interaction=nonstopmode report.tex 2>&1'` }
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.summary).toContain("LaTeX input file does not exist: report.tex");
    expect(evidence.command).toContain("pdflatex");
    expect(evidence.command).not.toContain("sh -lc");
    expect(evidence.output).toContain("Available .tex files: file paper.tex");
  });

  it("captures git diff output", async () => {
    const root = await createRoot();
    await writeFile(join(root, "a.txt"), "hello", "utf8");
    const tools = new WorkspaceTools({ workspaceRoot: root });
    const evidence = await tools.execute("task_1", undefined, {
      name: "gitDiff",
      input: {}
    });
    expect(evidence.status).toBe("failed");
  });

  it("returns diagnostics when resolver is configured", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({
      workspaceRoot: root,
      diagnosticsResolver: async () => [
        { file: "src/index.ts", severity: "error", message: "Type error", line: 10, column: 5 },
        { file: "src/index.ts", severity: "warning", message: "Unused var", line: 20 }
      ]
    });
    const evidence = await tools.execute("task_1", undefined, {
      name: "getDiagnostics",
      input: {}
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.summary).toContain("1 error(s)");
    expect(evidence.summary).toContain("1 warning(s)");
    expect(evidence.output).toContain("ERROR src/index.ts:10:5 - Type error");
  });

  it("returns clean diagnostics when no issues found", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({
      workspaceRoot: root,
      diagnosticsResolver: async () => []
    });
    const evidence = await tools.execute("task_1", undefined, {
      name: "getDiagnostics",
      input: {}
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.summary).toContain("No diagnostics found");
  });

  it("handles missing diagnostics resolver gracefully", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root });
    const evidence = await tools.execute("task_1", undefined, {
      name: "getDiagnostics",
      input: {}
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.summary).toContain("No diagnostics provider");
  });

  it("checks requested environment tools", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.execute("task_1", undefined, {
      name: "environmentCheck",
      input: { tools: ["python3"] }
    });

    expect(evidence.status).toBe("succeeded");
    expect(evidence.summary).toContain("Environment tools are available");
    expect(evidence.output).toContain("python3");
  });

  it("runs Python artifact validation with unittest fallback", async () => {
    const root = await createRoot();
    await writeFile(join(root, "calc.py"), "def add(a, b):\n    return a + b\n", "utf8");
    await writeFile(
      join(root, "test_calc.py"),
      "import unittest\nfrom calc import add\n\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\nif __name__ == '__main__':\n    unittest.main()\n",
      "utf8"
    );
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.validateArtifacts("task_1", "step_1");

    expect(evidence.some((item) => item.toolName === "environmentCheck")).toBe(true);
    expect(evidence.some((item) => item.toolName === "runTests" && item.status === "succeeded")).toBe(true);
    expect(evidence.map((item) => item.output).join("\n")).toMatch(/passed|Ran 1 test|OK/i);
  });

  it("records pytest crash reason when unittest fallback passes", async () => {
    const root = await createRoot();
    await writeFile(join(root, "pytest.py"), "import sys\nsys.exit(139)\n", "utf8");
    await writeFile(join(root, "calc.py"), "def add(a, b):\n    return a + b\n", "utf8");
    await writeFile(
      join(root, "test_calc.py"),
      "import unittest\nfrom calc import add\n\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n",
      "utf8"
    );
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.validateArtifacts("task_1", "step_1");
    const testEvidence = evidence.find((item) => item.toolName === "runTests");
    expect(testEvidence?.status).toBe("succeeded");
    expect(testEvidence?.summary).toContain("pytest failed/crashed with exit code 139");
    expect(testEvidence?.summary).toContain("unittest fallback passed");
  });

  it("stabilizes requested sliding-window deliverables from an implementation file", async () => {
    if (!commandExists("pylint") || (!commandExists("pdflatex") && !commandExists("latexmk"))) {
      return;
    }
    const root = await createRoot();
    await writeFile(
      join(root, "sliding_window.py"),
      "from collections import deque\n\n\ndef maxSlidingWindow(nums, k):\n    if k <= 0 or not nums or k > len(nums):\n        return []\n    q = deque()\n    out = []\n    for i, value in enumerate(nums):\n        while q and q[0] <= i - k:\n            q.popleft()\n        while q and nums[q[-1]] <= value:\n            q.pop()\n        q.append(i)\n        if i >= k - 1:\n            out.append(nums[q[0]])\n    return out\n",
      "utf8"
    );
    const prompt = "实现滑动窗口最大值，用pylint进行代码分析，用profile进行性能分析，用unittest进行单元测试，最后交付latex格式报告以及代码文件";
    const tools = new WorkspaceTools({ workspaceRoot: root, allowFileWrites: true, allowTerminalCommands: true });
    const generated = await tools.ensureRequestedDeliverables("task_1", "step_1", prompt);
    const validated = await tools.validateArtifacts("task_1", "step_1");
    const all = [...generated, ...validated];

    expect(existsSync(join(root, "test_sliding_window.py"))).toBe(true);
    expect(existsSync(join(root, "pylint_report.txt"))).toBe(true);
    expect(existsSync(join(root, "profile_report.txt"))).toBe(true);
    expect(existsSync(join(root, "report.tex"))).toBe(true);
    expect(existsSync(join(root, "report.pdf"))).toBe(true);
    expect(all.some((item) => item.toolName === "runTests" && item.status === "succeeded" && item.outcome?.category === "test")).toBe(true);
    expect(all.some((item) => item.toolName === "runCommand" && item.outcome?.category === "lint")).toBe(true);
    expect(all.some((item) => item.path?.endsWith("report.pdf"))).toBe(true);
  });

  it("compiles LaTeX artifacts when TeX is available", async () => {
    if (!commandExists("pdflatex") && !commandExists("latexmk")) {
      return;
    }
    const root = await createRoot();
    await writeFile(join(root, "report.tex"), "\\documentclass{article}\n\\begin{document}\nFlint report\n\\end{document}\n", "utf8");
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.validateArtifacts("task_1", "step_1");

    expect(evidence.some((item) => item.toolName === "runTests" && item.status === "succeeded" && item.summary.includes("Produced report.pdf"))).toBe(true);
    expect(existsSync(join(root, "report.pdf"))).toBe(true);
  });

  it("runs shell commands with inherited environment", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    const evidence = await tools.execute("task_1", undefined, {
      name: "runCommand",
      input: { command: "echo $HOME" }
    });
    expect(evidence.status).toBe("succeeded");
    expect(evidence.output).toBeTruthy();
    expect(evidence.output).not.toBe("");
  });

  it("detects missing LaTeX tool and gives clear error", async () => {
    const root = await createRoot();
    const tools = new WorkspaceTools({ workspaceRoot: root, allowTerminalCommands: true });
    await writeFile(join(root, "test.tex"), "\\documentclass{article}\\begin{document}Hello\\end{document}", "utf8");
    const evidence = await tools.execute("task_1", undefined, {
      name: "runCommand",
      input: { command: "nonexistent_latex_tool_12345 test.tex" }
    });
    // Should either fail because the tool doesn't exist, or succeed if somehow found
    // The key point is it doesn't hang or give a confusing error
    expect(evidence.status).toBe("failed");
  });

  it("discovers safe verification commands from package scripts without executing them", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          build: "tsc -p tsconfig.json",
          typecheck: "tsc --noEmit",
          postinstall: "dangerous-side-effect"
        }
      }),
      "utf8"
    );
    const tools = new WorkspaceTools({ workspaceRoot: root });
    const commands = await tools.discoverVerificationCommands();
    expect(commands.map((command) => command.script)).toEqual(["test", "build", "typecheck"]);
    expect(commands.some((command) => command.script === "postinstall")).toBe(false);
    expect(commands[0]).toMatchObject({ kind: "test", command: "npm test", required: true });
  });
});

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
