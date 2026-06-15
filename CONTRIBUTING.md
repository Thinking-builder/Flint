# Contributing

Thanks for working on Flint.

## Local Setup

```bash
npm install
npm run build
npm test
```

## Pull Requests

Please include:

- The task states affected by the change.
- Provider, scheduler, storage, or UI behavior affected.
- Tests for state transitions or failure handling when applicable.

Provider adapters must stay decoupled from the scheduler and orchestrator.
