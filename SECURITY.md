# Security

Flint is a local-first VS Code extension. It can call configured model providers and may eventually execute workspace actions, so security boundaries are part of the product contract.

## Defaults

- Telemetry is disabled by default.
- API keys are stored in VS Code SecretStorage.
- Webviews never receive plaintext API keys.
- Provider health checks do not send workspace content.
- File writes and terminal commands are disabled by default.

## Reporting

Please report vulnerabilities by opening a private security advisory on GitHub when available, or by contacting the maintainers listed in the repository.
