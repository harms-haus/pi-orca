# pi-orca

Pi extension with tools for driving the [Orca](https://orca-ide) IDE from a pi
session: profile-configured subagents in visible terminal tabs, terminal
interaction, tab management, and the embedded browser.

Pairs with [@harms-haus/pi-agent-profiles](../pi-agent-profiles): any valid
profile is selectable by exact name, so subagent-style profiles (no
`agentProfile: true`) launch fine via `orca_subagent` while staying out of
`/agent`.

## Install

```sh
pi install /path/to/this/repo        # global
pi install -l /path/to/this/repo     # project-local
```

## Tools

### `orca_subagent`

Spawn a subagent in a visible Orca terminal tab:

```json
{ "profile": "code-quality-reviewer", "task": "Review …", "wait": true }
```

- Launches the profile's agent in the chosen worktree, waits for the child
  to reach idle readiness, then delivers the task.
- Optional `agent` frontmatter field selects the CLI client that runs the
  profile: `pi` (default when absent) via `pi --agent-profile <profile>`;
  `claude` with the profile body as `--append-system-prompt`; `codex` with
  the body prepended to the first message (frontmatter `model` forwards to
  `--model` on both).
- `worktree`: omit for the active worktree, `"new"` for a fresh child worktree,
  or an Orca selector (`path:/repo`, `id:…`, `name:…`).
- `wait: true` polls until the child goes idle (3s slices, progress streamed)
  and returns its screen output; `timeout_seconds` caps the wait (default 600).
- The profile name is validated against `~/.pi/agent/profiles` and trusted
  `.pi/agent/profiles` before anything is spawned — an unknown name or an
  unsupported `agent` value fails fast instead of launching a profile-less
  child.
- The child keeps running in Orca regardless; monitor or follow up with
  `orca_terminal`.
- First-run quirks of the foreign CLIs: claude shows a folder-trust dialog it
  cannot skip in interactive mode (accept it once per folder — fresh
  worktrees each need one click); codex readiness is a settle delay and its
  completion an output-quiet watch, because a freshly launched codex never
  reports tui-idle at rest (verified on codex 0.158 — turn starts are
  observed natively via `terminal send --wait-submit`). Fast pi/claude turns
  can report `send-unverified` with the screen as evidence.

### `orca_terminal`

`action: read | send | wait` on any Orca terminal (the active one, or one
matched by handle / title substring / listing index). Use `screen: true` when
reading TUI apps like pi — accumulated stream output is useless for rendered
UIs.

### `orca_tabs`

`action: list | switch | close` for terminal and browser tab surfaces.
Terminal tabs are addressed by handle, title, or 1-based listing index; browser
tabs by page id or 0-based index (matching the Orca CLI).

### `orca_browser`

Drive Orca's embedded browser: `open/goto/back/reload/snapshot/screenshot/
click/fill/type/key/scroll/wait/close`. Core loop: `snapshot` → act on `@eN`
refs (`click`, `fill`) → re-snapshot — refs go stale after navigation or tab
switches.

Everything else (worktree CRUD, automations, artifacts, eval/console/network,
browser profiles, splits) stays on the `orca` CLI via bash.

## Requirements

- Pi ≥ 0.85, Orca ≥ 1.4 with the `orca` CLI available.
- Binary resolution: `$ORCA_CLI_COMMAND` → `$ORCA_DEV_REPO_ROOT` + `orca-dev`
  → `orca-ide` (Linux outside Orca) → `orca`.
- For subagents: profiles and provider auth configured as usual for pi; for
  `agent: codex`/`agent: claude` profiles, the respective CLI installed and
  authenticated.

## Development

```sh
pnpm install
pnpm test          # vitest unit suite
pnpm exec jiti scripts/smoke.ts    # live smoke against a running Orca (creates/closes real tabs)
pnpm exec jiti scripts/e2e.ts      # one real subagent round-trip (spawns a pi TUI)
pnpm exec jiti scripts/review.ts   # full code-quality-review run via the subagent flow
```

See `PLAN.md` for design decisions.
