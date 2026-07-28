# Contributing

Image Puma is released as-is: we are not actively fixing bugs or reviewing pull
requests. This document exists for people building from source, forking, or
interested in taking over maintenance — for the latter,
[contact Pantheon Network](https://www.pantheonnetwork.co/contact).

## Setup

```bash
npm install
npm run dev
```

Use Node 20.3 or newer, below Node 26. `npm run dev` starts the Electron app in watch mode.

## Checks

Run these to verify a change:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run smoke:e2e
```

## Desktop builds

```bash
npm run make
```

Desktop packaging requires Python 3.11 and bundles the RMBG-2.0 background-removal
model into the app. The first build needs access to the gated
[briaai/RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) model — accept its terms
on Hugging Face, then let the build download it (an accepted Hugging Face cache,
`HF_TOKEN`, or `IMAGE_PUMA_RMBG_MODEL_DIR` all work). Later builds reuse the cached
runtime in `build/`.

RMBG-2.0 is CC BY-NC 4.0 and requires a separate BRIA agreement for commercial
use. Do not distribute a commercial desktop build under the repository's MIT
license alone.

Installers are written to `out/make/` for the platform you build on and are not
code-signed; macOS users must allow the app through Gatekeeper on first launch.

## MCP server and packaging

```bash
npm run build:mcp        # compile the MCP CLI to dist/
npm run mcpb:pack -- --platform darwin --arch arm64
npm run mcpb:pack -- --platform win32 --arch x64
```

See [docs/mcp-packaging.md](docs/mcp-packaging.md) for verification, release
metadata sync, and registry listing steps.

## Releasing

Releases are built locally, not in CI:

```bash
npm version <major|minor|patch>
npm run make
npm run mcpb:pack -- --platform darwin --arch arm64
npm run mcpb:pack -- --platform win32 --arch x64
npm run release:sync && npm run registry:validate
git push origin main --follow-tags
```

Then attach the installers and `.mcpb` bundles to the GitHub Release for the tag.

## Assets

Splash screen photography is credited in [docs/credits.md](docs/credits.md) and is
not covered by the project license. Add a row there for any new image.
