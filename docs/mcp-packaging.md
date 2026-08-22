# MCP Packaging

## Protocol support

Image Puma is a **dual-era** MCP server over stdio. It speaks the `2026-07-28`
revision and every legacy revision the SDK supports, newest first:

```
2026-07-28  2025-11-25  2025-06-18  2025-03-26  2024-11-05  2024-10-07
```

Legacy clients keep using the `initialize` handshake and `ping`. Modern clients
skip the handshake entirely: every request is served statelessly, and
`server/discover` reports the supported versions, capabilities, and cache hints.

The 1.x TypeScript SDK stops at `2025-11-25`, so the modern surface lives in
[`src/mcp/protocol-2026.ts`](../src/mcp/protocol-2026.ts) — a transport wrapper
that answers `server/discover`, enforces per-request protocol versioning
(`-32022` on a version mismatch), stamps `resultType`, `_meta` server identity,
and `ttlMs`/`cacheScope` on results, and normalizes tool schemas to the JSON
Schema 2020-12 dialect. Tool handlers are untouched by it.

Two deliberate positions:

- **Roots are optional.** `roots/list` is deprecated in the modern revision and
  unavailable to stateless clients. The server never requests client roots:
  Cursor on Windows sends drive-letter workspace URIs that fail the MCP
  `file://` schema and abort the tool. `--allow-dir`, the process cwd, and the
  user's Pictures/Downloads/Documents/Desktop folders grant access instead.
- **Tool failures stay `isError` results.** Only protocol-level faults become
  JSON-RPC errors (`-32601` unknown method, `-32602` unknown tool or malformed
  params). A tool that runs and fails reports through `isError` so the model can
  self-correct, per SEP-1303.

`tests/mcp-protocol-2026.test.ts` pins all of the above, including a strict
2020-12 metaschema check over every tool's `inputSchema` and `outputSchema`.

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
