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

Spawn a pi subagent in a visible Orca terminal tab:

```json
{ "profile": "code-quality-reviewer", "task": "Review …", "wait": true }
```

- Launches `pi --agent-profile <profile>` in the chosen worktree, waits for the
  child to reach idle readiness, then delivers the task.
- `worktree`: omit for the active worktree, `"new"` for a fresh child worktree,
  or an Orca selector (`path:/repo`, `id:…`, `name:…`).
- `wait: true` polls until the child goes idle (3s slices, progress streamed)
  and returns its screen output; `timeout_seconds` caps the wait (default 600).
- The profile name is validated against `~/.pi/agent/profiles` and trusted
  `.pi/agent/profiles` before anything is spawned — an unknown name fails fast
  instead of launching a profile-less child.
- The child keeps running in Orca regardless; monitor or follow up with
  `orca_terminal`.

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
- For subagents: profiles and provider auth configured as usual for pi.

## Development

```sh
pnpm install
pnpm test          # vitest unit suite
pnpm exec jiti scripts/smoke.ts    # live smoke against a running Orca (creates/closes real tabs)
pnpm exec jiti scripts/e2e.ts      # one real subagent round-trip (spawns a pi TUI)
pnpm exec jiti scripts/review.ts   # full code-quality-review run via the subagent flow
```

See `PLAN.md` for design decisions.
