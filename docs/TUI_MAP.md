# Config Studio — TUI Map

> Mental map of the entire studio TUI: which screen lives where, which option goes to which menu, what is a link vs an editor. Update this file whenever menus move.
>
> Companion to `SETTINGS_REFERENCE.md` (which documents the *settings themselves* — this file documents the *menus*).

## Conventions

- **Menu** = a list of selectable options. **View** = read-only info (paged text). Only menus can be pinned.
- **Pin depth rule**: Quick access holds (a) two fixed defaults — Providers & models explorer, Agents — that are always present and cannot be unpinned, and (b) pinned **Menu-2+** screens (children of a main-menu screen). Menu-1 screens cannot be pinned (they are the main menu). Views (Diagnostics, How it works, capture bodies) cannot be pinned.
- `f` on a pinnable menu toggles its Quick access pin; `/` searches any menu; `i` shows help.
- **One home per editor**: when a setting appears in two places, one is a *link* that opens the single editor (marked → below). No parallel implementations.

## Map

```
Config Studio (main menu)
│
├── QUICK ACCESS (top section, always)
│   ├── Providers & models ............ fixed default → link to explorer (below)
│   ├── Agents ........................ fixed default → link to Agents screen (below)
│   └── <pinned deep screens> ......... Menu-2+ screens pinned with f
│
├── ── main ── (divider)
│
├── Settings ........................... ALL opencode.json root keys, grouped
│   ├── Sharing & updates
│   │   ├── share (manual/auto/disabled)
│   │   ├── autoupdate (true/false/notify)
│   │   ├── username
│   │   └── enterprise {url}
│   ├── Models & agents
│   │   ├── model / small_model ........ root model pickers (THE editors)
│   │   ├── default_agent
│   │   ├── subagent_depth
│   │   └── agent ..................... → LINK to Agents screen (no second editor)
│   ├── Providers
│   │   ├── disabled_providers ......... stringList; picker = full universe
│   │   │                              minus enabled_providers (no overlap)
│   │   ├── enabled_providers .......... stringList; picker = universe
│   │   │                              minus disabled_providers
│   │   └── provider ................... FULL universe list (runtime + catalog +
│   │                                  config; green = enabled, white = disabled/
│   │                                  excluded/catalog-only; selecting a row without
│   │                                  a config entry stages one and opens the editor)
│   │       └── provider entry ......... name, api, npm (26 SDK suggestions),
│   │           (per provider)          env, whitelist, blacklist, options,
│   │                                  models →
│   │           └── model entry ........ full model fields: id, family,
│   │               (per model)          release_date, attachment, reasoning,
│   │                                  temperature, tool_call, interleaved,
│   │                                  status, limit{context,input,output},
│   │                                  cost{...}, modalities{input,output},
│   │                                  options (default request options),
│   │                                  headers, per-model provider{npm,api},
│   │                                  variants (json; also managed below)
│   ├── Tools & files
│   │   ├── shell (suggested list + custom)
│   │   ├── instructions (concat-merge stringList)
│   │   ├── skills {paths, urls}
│   │   ├── references (map; git/local entries)
│   │   ├── mcp ....................... MCP manager: server list →
│   │   │                              local {command, cwd, environment, timeout}
│   │   │                              remote {url, headers, oauth, timeout}
│   │   │                              {enabled:false} overlays
│   │   ├── command ................... slash commands: template, description,
│   │   │                              agent, model, variant (live suggestions),
│   │   │                              subtask
│   │   ├── permission ................ rules editor: shorthand + per-tool
│   │   │                              pattern lists (ask/allow/deny)
│   │   ├── formatter (built-ins + custom command/extensions)
│   │   ├── lsp (built-ins + custom command/extensions)
│   │   └── watcher {ignore}
│   ├── Session behavior
│   │   ├── attachment {image sizing}
│   │   ├── tool_output {max_lines, max_bytes}
│   │   ├── compaction {auto, prune, tail_turns, ...}
│   │   └── snapshot
│   ├── Server
│   │   └── server {port, hostname, mdns, cors}
│   ├── Developer
│   │   ├── plugin .................... → LINK to Plugins screen (below)
│   │   └── experimental (flags)
│   └── Deprecated .................... deprecated keys + migrate hints
│
├── Providers & models (explorer) ...... CATALOG lens (read + deep edit)
│   ├── provider list .................. all runtime providers, edited first
│   │   └── model detail .............. variants (add/edit/clone/disable/delete),
│   │                                  default options (copy from variant),
│   │                                  deep config fields (link to model entry),
│   │                                  capture request (sink), A/B diff
│   └── ! New custom provider ......... staged add → same provider entry editor
│
├── Agents ............................ agent list (+ new custom agent)
│   └── agent detail (AV-style) ....... Model, Model variant, Temperature,
│       Top P, Prompt, Description, Options, Color (config-staged) +
│       Agent Variants submenu (variants, parent fields/presets when module on)
│
├── TUI settings (tui.json) ........... theme (33+), keybinds (184 commands,
│   browse/set/clear), diff_style, cursor, mouse, scroll, attention sounds,
│   prompt sizing, plugin_enabled, tui plugin entries. Always restart.
│
├── Plugins ........................... unified plugin manager: entries from
│   opencode.json + tui.json, add/remove, options tuples, layer badges
│
├── Cleanup & migrations .............. deprecated-key scan → staged migrations
│
├── Config files ...................... layer list (precedence), per-file view,
│   backups browser (config + sidecar)
│
├── Diagnostics (VIEW) ................ merge report, hidden layers, module
│   diagnostics, migrate hints, deprecated scan
│
├── How it works (VIEW) ............... request pipeline, variants, precedence,
│   capture design
│
├── Modules ........................... module toggles + integration options
│   (Agent Variants own-menu switch, ...)
│
├── Advanced .......................... dialog size slider (live preview),
│   capture section toggles, module advanced tools (AV debug, prompt markers,
│   log view/clear, sidecar backups)
│
├── Review staged changes (N) ......... diff of staged ops + sidecar changes
│   (appears when pending > 0)
│
└── Save & exit ....................... write all staged changes (backup first),
    reload config once, restart-reason summary (red), close
```

## Where a setting is edited (single-home table)

| Setting | Home | Other appearances |
|---|---|---|
| model / small_model | Settings → Models & agents | — (old main-menu screen removed) |
| agent.<name>.* | Agents screen (AV-style detail) | Settings → agent row is a link |
| provider.<id>.* | Settings → Providers → provider (universe list) | Explorer opens the same entry editor |
| models.<mid>.variants | Model detail (explorer) or model entry (Settings) — same editor | — |
| disabled/enabled_providers | Settings → Providers (pickers deduped against each other) | — |
| plugin (server config) | Plugins screen | Settings → Developer → plugin row is a link |
| tui.json keys | TUI settings | — |
| Agent Variants sidecar | Agents screen → AV submenu (or its own menu when own-menu mode) | staged into the same Save & exit |

## Navigation rules

- Esc ≡ `< Back` ≡ exactly one level up, everywhere.
- Screens loop and re-present after child actions (they never fall through to main).
- `/` opens the search box: letters type, backspace edits, Enter saves the filter (list stays filtered; footer shows `filter: <query>`), Esc clears.
- `f` pins/unpins the current menu (Menu-2+ only) to Quick access.
