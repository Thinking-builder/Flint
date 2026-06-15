# Release

## Build a VSIX

```bash
npm install
npm run build
npm run package:vsix
```

The generated `.vsix` can be installed with:

```bash
code --install-extension apps/vscode-extension/flint-*.vsix
```

Marketplace and Open VSX publishing require publisher credentials and are intentionally not automated in the MVP.
