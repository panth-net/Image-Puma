# MCP Packaging

## npm

Build the MCP CLI:

```bash
npm run build:mcp
```

The package exposes `image-puma` and `image-puma-mcp` as aliases for `dist/cli.js`.

```bash
image-puma mcp serve --transport stdio --allow-dir /Users/you/Pictures
image-puma-mcp serve --allow-dir /Users/you/Pictures
npx -y image-puma@1.0.0 mcp serve --transport stdio --allow-dir /Users/you/Pictures
```

Run the local checks:

```bash
npm run build:mcp
node dist/cli.js mcp doctor --allow-dir /Users/you/Pictures
node dist/cli.js mcp config --allow-dir /Users/you/Pictures
npm run package:verify
```

## MCPB

Prepare and pack the current platform:

```bash
npm run mcpb:pack
```

Prepare specific release targets:

```bash
npm run mcpb:pack -- --platform darwin --arch arm64
npm run mcpb:pack -- --platform win32 --arch x64
```

Artifacts are written to `dist-mcpb/`, with SHA-256 hashes in `dist-mcpb/SHA256SUMS`.

Verify bundle contents:

```bash
npm run mcpb:verify
```

## Release metadata

`server.json` pins each `.mcpb` by download URL and SHA-256, so both go stale
whenever the bundles are rebuilt or the version changes. After packing every
target, sync and validate:

```bash
npm run release:sync
npm run registry:validate
```

`release:sync` rewrites the version, the release download URLs, and the
`fileSha256` of each bundle from the files in `dist-mcpb/`. `registry:validate`
is the gate that proves it was run — it fails if a committed hash disagrees with
a local artifact.

Run both by hand after packing every target and before committing a release, so
the published metadata always describes the exact files attached to the release.

## Registry publishing

To list the server in the official MCP registry, publish `server.json` with
[`mcp-publisher`](https://github.com/modelcontextprotocol/registry) after the
GitHub Release exists and the npm package is live. The `io.github.panth-net/*`
namespace is proven by GitHub authentication, and `package.json` must keep its
`mcpName` field matching `server.json`'s `name`.

GitHub Release `.mcpb` installs require manual reinstall for updates unless the bundle is distributed through a host-supported extension directory with auto-update.
