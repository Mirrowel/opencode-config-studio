# opencode-config-studio

An [OpenCode](https://opencode.ai) plugin for inspecting and editing model variants and request defaults across your config files — a visual config editor focused on models and variants, with **Agent Variants embedded as a module**.

## What it does

- **See what each model sends.** Browse the merged provider catalog, every model's variants, and the exact request body each variant produces — including what "default" (no variant) resolves to per model.
- **Know where every value comes from.** All config files (global, `OPENCODE_CONFIG`, project, `.opencode` dirs) are parsed and merged with per-key provenance: file X, models.dev catalog, or OpenCode-internal base defaults.
- **Edit the files themselves, surgically — and in batches.** Changes go through jsonc-parser — the same library OpenCode uses — so comments, formatting, and unrelated keys survive. Edits are staged in memory, reviewed as diffs, and written together on Save & exit (one config reload, restart reasons collected, red-flagged like Agent Variants does).
- **Capture the real request.** A local sink runs OpenCode's full request pipeline against a listener on 127.0.0.1 — no provider is contacted, no config file is modified, the temp session is cleaned up — and shows the exact body (heavy sections hidden by default, per-section toggles), plus A/B diffs between default and any variant.
- **Agent Variants, embedded.** The full [agent-variants](https://github.com/Mirrowel/opencode-agent-variants) feature set is a studio module: variants and parent fields live on each agent's page, model presets on the Agents screen, diagnostics and docs are merged. The standalone plugin keeps working on its own; if both are installed the studio offers to remove the duplicate and takes over routing.

## Install

```sh
opencode plugin install @mirrowel/opencode-config-studio
```

Requires OpenCode with TUI plugin support (`@opencode-ai/plugin` >= 1.14.0). Registering the plugin in `opencode.json` is enough — the server part wires the TUI registration into `tui.json` automatically.

## Use

Open the palette and run **Config Studio: Models & Variants** (or `/config-studio`).

- **Browse providers & models** — providers and models edited in any config file are listed first and highlighted; then inspect variants (with source badges: catalog / config / hidden), default options, agent usage, and request captures.
- **Default options** — `provider.<id>.models.<id>.options` is the "default" lever: keys set here are sent on every invocation of the model that doesn't select a variant carrying the same keys. Copy a variant body here in one action.
- **Agents** — edit `agent.<name>.model`, `variant`, `temperature`, `top_p`; the Agent Variants section adds per-agent **variants** management and **AV parent fields** (propagation); model presets are managed here too.
- **Config files** — inspect every discovered layer, create missing ones, set the write target, and restore backups.
- **Review staged changes** — every edit (files and modules) queues here: per-change diffs, discard single items or everything, then Save & exit writes all files with backups and reloads OpenCode config once.
- **Modules** — toggle embedded modules and their layout. Agent Variants can run integrated (default) or as its own top-level menu; disabling a module removes its menus immediately (its server-side parts stop at the next restart).
- **`[i]` everywhere** — every field and concept has a documentation view injected with the live value and its provenance.

## How editing works

1. You pick an edit target file (Config Studio suggests the file that currently wins the merge for the value you're editing; it warns when a higher-precedence file would shadow your edit).
2. The edit is staged in memory and overlaid onto the parsed files, so every view already shows the post-save values.
3. On Save & exit, each staged edit becomes a minimal JSONC text patch — comments and unrelated formatting are preserved — with a snapshot of the previous content stored under `~/.config/opencode/config-studio/backups/`.
4. Files are written atomically (temp file + rename) and verified.
5. OpenCode is asked to reload its config (instance disposal), so changes apply to new requests without restarting the app. Restart-required changes are summarized in red.

## Request capture

The capture feature spawns a temporary `opencode serve` process in a temp directory with an inline env config (`OPENCODE_CONFIG_CONTENT`) that redirects the target provider's `baseURL` to a local listener. The provider keeps its real ID and runtime package, so base defaults and SDK serialization match reality. A minimal prompt is sent through the full pipeline, the outgoing body is captured, a minimal SSE reply is returned, the session is deleted, and the server is shut down. Nothing reaches any real provider and no config file is touched.

## Agent Variants module

Embedded from `@mirrowel/opencode-agent-variants` (wizard library + server routing):

- **Integrated layout (default):** per-agent variant management (add/edit/toggle/delete), AV parent fields with propagation, and model presets on the Agents screen. Diagnostics, How-it-works, staged changes, and Save & exit are always merged with the studio's own.
- **Own-menu layout:** one Agent Variants entry opens the full wizard.
- **Saves are staged:** wizard changes join the studio's unified change queue instead of writing immediately.
- **Routing:** the studio's server part runs the embedded router only when the standalone plugin is not registered anywhere (and the module is enabled). If a standalone registration is detected, the studio offers to remove it and shows a restart-required notice; until restart the standalone keeps routing.
- The standalone plugin remains fully independent — both installs can coexist safely during the transition.

## Development

```sh
npm install
npm run ci:package   # typecheck + build + unit tests + reactivity smoke + pack dry-run + package smoke
```

The TUI is precompiled with OpenTUI's Solid transform (`npm run build:tui`) — raw TSX exports do not repaint reactively in npm-installed plugins.

Developing against a local agent-variants checkout: `node scripts/dev-link.mjs link && npm install` (switch back with `unlink <version>`; releases refuse `file:` dependencies).

## License

MIT
