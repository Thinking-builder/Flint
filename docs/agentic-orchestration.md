# Agentic Orchestration Notes

This document describes the first compatibility-focused upgrade from Flint's linear MVP flow toward resource-aware, self-iterating task orchestration.

## Current Problems Addressed

- Judge output, deterministic checks, and acceptance-criteria results could disagree without a single canonical verdict.
- The orchestrator revised once with hard-coded behavior instead of using an explicit iteration policy.
- Progress was implicit in event logs and judge text, so stagnation and repeated failure were hard to detect.
- Scheduler concurrency did not account for tasks touching the same files or directories.
- Plans were represented only as linear steps, leaving no path toward DAG scheduling.
- Failed tasks did not produce reusable local memory for future similar tasks.

## New Runtime Structures

- `IterationPolicy` defines attempt, tool-iteration, tool-call, stagnation, branching, and human-review limits.
- `ProgressLedger` tracks score history, checks, findings, blockers, hypotheses, attempts, and tool-call counts.
- `TaskGraph` and `TaskGraphNode` provide a DAG-compatible view over existing `TaskPlanStep` data.
- `ResourceLock` models read/write locks over files, directories, workspaces, terminals, and future git worktrees.
- `Attempt` records each strategy pass with verification results, patch summary, status, and score.
- `Reflection` stores local task experience for future planning context.

## Verdict Flow

The judge package now exposes canonical verdict helpers:

```ts
finalVerdict = mergeVerdicts({
  llmJudgeVerdict,
  deterministicCheckVerdict,
  criteriaVerdict,
  humanReviewVerdict
});
```

The orchestrator stores this canonical verdict in both `verdict` and `overallVerdict`. A passing LLM judge can no longer complete a task when deterministic checks or acceptance criteria require review.

## Iteration Flow

Each task starts with a normalized `IterationPolicy` and empty `ProgressLedger`.

After every judge pass:

1. Flint runs deterministic checks.
2. Flint merges LLM, deterministic, and criteria verdicts.
3. Flint updates the progress ledger.
4. Flint closes the current attempt with score and verification evidence.
5. Flint decides whether to complete, continue, or require review.

The default policy allows up to three attempts and stops early on stagnation, tool budget exhaustion, or review-worthy risk.

## Scheduler Locks

The scheduler still uses simple priority ordering and `maxConcurrentTasks`, but queued tasks with conflicting `ResourceLock` entries are skipped while active conflicting work is running.

This is intentionally local and conservative. It is not a distributed lock manager. It creates the interface needed for future subtask-level scheduling and isolated git worktree attempts.

## Reflection Memory

`FileStorage` now persists reflections in the existing JSON state file. When planning a similar task in the same workspace fingerprint, Flint loads recent reflections and injects them into provider planning context.

Reflections are created when tasks complete, fail, are cancelled, or pause for user input.

## Verification-First Support

`WorkspaceTools.discoverVerificationCommands()` reads `package.json` and returns safe verification commands for known scripts such as `test`, `build`, `typecheck`, `lint`, and `compile`. It does not execute scripts during discovery.

The root `npm test` script now builds workspace packages first so tests do not accidentally run against stale `dist` output.

## Migration Notes

Existing tasks and state files remain compatible because all new task fields are optional:

- Older tasks without `iterationPolicy` receive the default policy at runtime.
- Older tasks without `progressLedger`, `taskGraph`, `attempts`, or `resourceLocks` still execute through the existing plan-step path.
- Older storage JSON files without `reflections` are normalized on `FileStorage.init()`.

## Next Steps

- Execute independent `TaskGraphNode` branches concurrently when resource locks allow it.
- Add real attempt isolation through git worktrees or temporary workspace overlays.
- Add higher-fidelity project fingerprinting from package manager files and source tree metadata.
- Promote verification command discovery into automatic verification runs gated by permission policy.
- Add risk scoring for large deletes, lockfile changes, security-sensitive files, and widening edit scope.
