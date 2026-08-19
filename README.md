# Image Puma

Local batch image preparation for the web via a desktop app or directly within your AI via MCP server. Image processing runs locally; Image Puma does not upload your images, require an account, or do any other nonsense. All local image processing.

![Image Puma brand illustration](assets/brand/image-puma-original.webp)

## Use the App

Download the current Image Puma desktop installer from GitHub Releases:

- macOS (Apple Silicon): [Image-Puma.dmg](https://github.com/panth-net/Image-Puma/releases/download/v1.0.0/Image-Puma.dmg)
- Windows: desktop installer coming soon — Windows is fully supported in Claude via the MCP server below, or build from source on a Windows machine with `npm install && npm run make` (needs Python 3.11 and access to the gated [RMBG-2.0 model](https://huggingface.co/briaai/RMBG-2.0) for the background remover).

The desktop app and MCP server are independent components — install either one on its own, or both together, depending on your needs.

Our installers aren't code-signed. This is a free app, and we'd rather not pay Apple's $99/year developer fee just to make it a "real app" in the eyes of the OS. As a result:

- macOS will block the app on first launch. To open it, right-click the app and select Open, or go to System Settings → Privacy & Security → General and click "Open Anyway."

- Windows will show a SmartScreen warning. Click "More info," then "Run anyway" to proceed.

## Use It in Claude

### Claude Desktop (one-click)

One-click Claude Desktop install uses the `.mcpb` bundles from GitHub Releases. 
- Download the file for your computer,
- open it in Claude Desktop,
- choose the image folders Image Puma may access when prompted,
- then restart Claude Desktop if it asks

Use the following links:
- Apple Silicon Mac: [image-puma-mcp-darwin-arm64.mcpb](https://github.com/panth-net/Image-Puma/releases/download/v1.0.0/image-puma-mcp-darwin-arm64.mcpb)
- Windows: [image-puma-mcp-win32-x64.mcpb](https://github.com/panth-net/Image-Puma/releases/download/v1.0.0/image-puma-mcp-win32-x64.mcpb)

The MCPB installer asks you to choose allowed image folders. Image Puma can only read from and write into those folders.

### Add it to Claude Code

For coding sessions (optimizing project assets, generating favicons, prepping images for deploys), add the MCP server with one command:

```bash
claude mcp add --scope user image-puma -- "$(command -v npx)" -y image-puma mcp serve --transport stdio --allow-dir ~/Pictures ~/Downloads ~/Documents
```

`--scope user` makes Image Puma available in **every** repo and terminal on your machine; leave it off and it only loads in the folder you ran the command from. Swap the folders for whatever Image Puma should be allowed to touch — add a project folder to let it optimize the images in that repo, e.g. "compress every image in `assets/` for the web".

Copy that `"$(command -v npx)"` part exactly — it expands to the full path of `npx` when you run it. Registering a bare `npx` looks fine and then fails to connect, because MCP servers are launched with a minimal PATH that doesn't include Node version managers like nvm, fnm, or Volta. See [Node not found](#node-not-found) below.

Then start a **new** Claude Code session (new conversation in the VS Code extension, or a fresh `claude` in the terminal) — MCP servers and their commands are discovered at session start, so already-open sessions won't see it. Check it's connected any time with `claude mcp list`.

If you cloned this repo instead, point the command at your local build (absolute path):

```bash
npm install && npm run build:mcp
claude mcp add --scope user image-puma -- "$(command -v node)" /absolute/path/to/Image-Puma/dist/cli.js mcp serve --transport stdio --allow-dir ~/Pictures
```

### Any other MCP client

Developer install with `npx`, using an absolute allowed folder path:

```json
{
  "mcpServers": {
    "image-puma": {
      "command": "/usr/local/bin/npx",
      "args": [
        "-y",
        "image-puma",
        "mcp",
        "serve",
        "--transport",
        "stdio",
        "--allow-dir",
        "/Users/you/Pictures"
      ]
    }
  }
}
```

Use absolute paths everywhere in `mcpServers` JSON — for the allowed folders **and** for `command`. Run `command -v npx` in your terminal and paste whatever it prints in place of `/usr/local/bin/npx`. On native Windows, use `"command": "cmd"` with `"/c"` and `"npx"` as the first two args instead.

### What it looks like in use

Once installed (any of the ways above), just ask Claude in plain language:

> **You:** Compress the images in `~/Pictures/site` for web upload
>
> **Claude:** Here's the plan — 14 images accepted, converting to WebP, resized for web, metadata stripped. It lists the exact output paths so you can see nothing gets overwritten. Run it?
>
> **You:** yes
>
> **Claude:** Done — 14 of 14 succeeded, 41.8 MB in, 3.6 MB out.

Image Puma always **plans first**: you see which files it accepted, what settings apply, and where every output will be written — nothing touches disk until you confirm. And it can only see the folders you allowed during install.

Example prompts:

- Compress these images for web upload: `/Users/you/Pictures/site`
- Compress these images for email: `/Users/you/Desktop/photos`
- Strip metadata from these images: `/Users/you/Downloads`
- Make thumbnails from these images: `/Users/you/Pictures/products`
- Generate a favicon and app-icon bundle from `/Users/you/Projects/my-app/logo.png` into `/Users/you/Projects/my-app/public`

### The `/image-puma` command

Image Puma ships one slash command that tells Claude to handle whatever image job you describe with the Image Puma tools — plan first, confirm, then run:

```
/image-puma compress everything in ~/Pictures/site for the web
```

In the **Claude Code terminal**, type `/image-puma` and the command menu finds it (its full name is `/mcp__image-puma__image-puma`). In **Claude Desktop**, the same prompt lives under the **+ menu** in the chat input, listed under Image Puma.

For a bare `/image-puma` command that also works in the **VS Code extension** (whose command menu doesn't list MCP prompts), save this as `~/.claude/commands/image-puma.md`:

```markdown
---
description: Batch image work via Image Puma (compress, resize, strip metadata, thumbnails, favicons)
---

Use the Image Puma MCP tools for this local image task: $ARGUMENTS

If no task was given, ask which images to process and what result is wanted.

Create a plan first with image_puma_plan — plan only, do not run it yet. Pick a preset with image_puma_list_presets, or use custom settings (schema via image_puma_settings_schema). Show the returned plan, warnings, and planned output paths, and call image_puma_run only after the user explicitly confirms.
```

New sessions then get `/image-puma` everywhere — terminal and VS Code — as long as the MCP server from "Add it to Claude Code" above is registered.

Quick favicon generation is available through `image_puma_generate_favicon`.

## Troubleshooting

### Node not found

`claude mcp list` shows Image Puma as failed, with `ENOENT: Executable not found in $PATH: "npx"` (or `"node"`):

```
image-puma: npx -y image-puma mcp serve ... - ✘ Failed to connect
```

Your MCP client launches servers with a minimal PATH that never sources `~/.zshrc` or `~/.bashrc`, so a Node installed through nvm, fnm, Volta, or asdf is invisible to it even though your terminal finds it fine. Fix it by re-registering with an absolute path:

```bash
claude mcp remove image-puma -s user
claude mcp add --scope user image-puma -- "$(command -v npx)" -y image-puma mcp serve --transport stdio --allow-dir ~/Pictures
```

Then start a new session and check `claude mcp list` again.

One catch if you use nvm: `command -v npx` resolves to a version-pinned path like `~/.nvm/versions/node/v24.13.1/bin/npx`, which stops existing the next time you upgrade Node. Either re-run the two commands above after an upgrade, or point Image Puma at a Node that isn't managed by nvm (`/opt/homebrew/bin/node` or `/usr/local/bin/node`) so the path stays valid. Image Puma needs Node 20.3.0 or newer.

Claude Desktop users can skip all of this — the `.mcpb` bundle above ships with its own Node runtime.

### Windows resolves `npx image-puma` to a local checkout

On Windows, running `npx image-puma ...` from inside a directory named `image-puma` (case-insensitively), such as a clone of this repository, can make npm resolve the package name to that local directory instead of the published package. If the checkout has not been built, the command fails with `'image-puma' is not recognized as an internal or external command`.

Run the `npx image-puma ...` command from a different working directory. When developing from a clone, build it with `npm run build:mcp` and point the MCP server directly at the local `dist/cli.js` instead of invoking it through `npx`.

### Anything else

Run the built-in check, which reports Node version, Sharp, ExifTool, and whether your allowed folders are actually writable:

```bash
npx -y image-puma mcp doctor --allow-dir ~/Pictures
```

## Contribute

Image Puma is released as-is by [Pantheon Network](https://www.pantheonnetwork.co/contact).
We are not actively fixing bugs or reviewing pull requests. If you'd like to take over
maintenance, [contact us](https://www.pantheonnetwork.co/contact).
Development setup, checks, and the build process are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Support Matrix

Format and OS behavior is documented in [docs/support-matrix.md](docs/support-matrix.md). HEIC/HEIF gets a macOS-only ImageIO fallback through `sips`; Windows and Linux rely on Sharp/libvips support.
