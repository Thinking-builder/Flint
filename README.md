<p align="center">
  <img src="apps/vscode-extension/media/logo-icon.svg" alt="Flint logo" width="96" height="96">
</p>

<h1 align="center">Flint</h1>

<p align="center">
  Local-first AI task orchestration for VS Code.
</p>

Flint turns AI-assisted development work into a visible local task queue. Instead of another chat sidebar, it models tasks with explicit states, provider execution, human pauses, durable events, and judge results.

## What Flint Provides

- A VS Code Activity Bar view for managing queued AI tasks.
- A local task lifecycle covering `queued`, `dispatching`, `running`, `waiting_user`, `judging`, `review_required`, `completed`, `failed`, and `cancelled`.
- Provider adapters for OpenAI-compatible APIs and Ollama.
- API key storage through VS Code SecretStorage.
- Local-first task event persistence behind a storage abstraction.
- Judge result schemas with a safe fallback to `review_required`.
- No telemetry by default.

## Repository Layout

```text
apps/
  vscode-extension/      VS Code extension and webview UI
packages/
  core-types/            Shared task and domain types
  judge/                 Judge schemas and result handling
  orchestrator/          Task orchestration flow
  providers/             Model provider adapters
  scheduler/             Queue scheduling primitives
  storage/               Local persistence abstraction
  ui-tokens/             Flint design tokens
  workspace-tools/       Workspace utility layer
examples/
  local-only/            Local provider configuration example
docs/
  release.md             Release notes and packaging guidance
```

## Development

```bash
npm install
npm run build
npm test
npm --workspace flint-vscode run compile
```

After installing dependencies, open `apps/vscode-extension` in VS Code or run the extension launch configuration from the repository root.

## Data Boundaries

Flint does not run a hosted backend in this MVP. Workspace content is only sent to configured providers when a task is executed. API keys are stored through VS Code SecretStorage and are not sent to the webview.

## License

Apache-2.0.
