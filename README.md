# opencode-config-studio

An [OpenCode](https://opencode.ai) plugin for inspecting and editing model variants and request defaults across your config files — a visual config editor focused on models and variants.

## What it does

- **See what each model sends.** Browse the merged provider catalog, every model's variants, and the exact request body each variant produces — including what "default" (no variant) resolves to per model.
- **Know where every value comes from.** All config files (global, `OPENCODE_CONFIG`, project, `.opencode` dirs) are parsed and merged with per-key provenance: file X, models.dev catalog, or OpenCode-internal base defaults.
- **Edit the files themselves, surgically.** Changes go through jsonc-parser — the same library OpenCode uses — so comments, formatting, and unrelated keys survive. Real deletions, not stubs. Atomic writes, automatic backup snapshots, post-write verification, and a reload trigger so changes apply without restarting OpenCode.
- **Capture the real request.** A local sink runs OpenCode's full request pipeline against a listener on 127.0.0.1 — no provider is contacted, no config file is modified, the temp session is cleaned up — and shows the exact body, plus A/B diffs between default and any variant.

## Install

```sh
opencode plugin install @mirrowel/opencode-config-studio
```

Requires OpenCode with TUI plugin support (`@opencode-ai/plugin` >= 1.14.0).

## Use

Open the palette and run **Config Studio: Models & Variants** (or `/config-studio`).

- **Browse providers & models** — providers and models edited in any config file are listed first and highlighted; then inspect variants (with source badges: catalog / config / hidden), default options, agent usage, and request captures.
- **Default options** — `provider.<id>.models.<id>.options` is the "default" lever: keys set here are sent on every invocation of the model that doesn't select a variant carrying the same keys. Copy a variant body here in one action.
- **Agents** — edit `agent.<name>.model`, `variant`, `temperature`, `top_p`.
- **Config files** — inspect every discovered layer, create missing ones, set the write target, and restore backups.
- **`[i]` everywhere** — every field and concept has a documentation view injected with the live value and its provenance.

## How editing works

1. You pick an edit target file (Config Studio suggests the file that currently wins the merge for the value you're editing; it warns when a higher-precedence file would shadow your edit).
2. The edit is applied as a minimal JSONC text patch — comments and unrelated formatting are preserved.
3. A snapshot of the previous file content is stored under `~/.config/opencode/config-studio/backups/`.
4. The file is written atomically (temp file + rename) and read back to verify.
5. OpenCode is asked to reload its config (instance disposal), so the change applies to new requests without restarting the app.

## Request capture

The capture feature spawns a temporary `opencode serve` process in a temp directory with an inline env config (`OPENCODE_CONFIG_CONTENT`) that redirects the target provider's `baseURL` to a local listener. The provider keeps its real ID and runtime package, so base defaults and SDK serialization match reality. A minimal prompt is sent through the full pipeline, the outgoing body is captured, a minimal SSE reply is returned, the session is deleted, and the server is shut down. Nothing reaches any real provider and no config file is touched.

## Development

```sh
npm install
npm run ci:package   # typecheck + build + unit tests + reactivity smoke + pack dry-run + package smoke
```

The TUI is precompiled with OpenTUI's Solid transform (`npm run build:tui`) — raw TSX exports do not repaint reactively in npm-installed plugins.

## License

MIT
