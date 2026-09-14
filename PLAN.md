# pi-orca — Orca IDE tools for pi-coding-agent

A pi package (`@harms-haus/pi-orca`) that gives pi sessions tools to drive the running
Orca app: spawn profile-configured pi subagents in visible terminal tabs, interact with
terminal sessions, manage tabs, and drive Orca's embedded browser. Everything niche stays
on the `orca` CLI via bash.

## Decisions (confirmed)

- `orca_subagent` runs the child pi in an **Orca terminal tab** (IDE-visible, resumable),
  launched as `pi --agent-profile <profile>`.
- `wait: true` blocks until the child goes idle, polling every ~3s (`terminal wait --for
  tui-idle` in a loop, streaming progress); default is fire-and-forget returning the handle.
- `worktree` param: omit → active worktree; `"new"` → child worktree; else Orca selector.
- Four tools: `orca_subagent`, `orca_terminal`, `orca_browser`, `orca_tabs`.

## Tool surface (v1)

| Tool | Params | Orca commands |
| --- | --- | --- |
| `orca_subagent` | `profile`, `task`, `title?`, `worktree?`, `wait?`, `timeout_seconds?` | `worktree create`, `terminal create --command "pi --agent-profile …"`, `terminal wait/send/read` |
| `orca_terminal` | `action: read\|send\|wait`, `terminal?`, plus `text?`/`enter?`/`for?`/`timeout_seconds?` | `terminal read/send/wait` |
| `orca_tabs` | `kind: terminal\|browser`, `action: list\|switch\|close`, `terminal?`/`index?` | `terminal list/switch/close`, `tab list/switch/close` |
| `orca_browser` | `action: open\|goto\|back\|reload\|snapshot\|screenshot\|click\|fill\|type\|key\|scroll\|wait\|close`, plus `url?`, `ref?`, `value?`, `text?`, `key?`, `direction?`, `amount?`, `index?`, `selector?`, `load_state?`, `full?` | `tab create/close`, `goto/back/reload/snapshot/screenshot/click/fill/type/keypress/scroll/wait` |

Deliberately excluded (use `orca` CLI from bash): worktree CRUD beyond subagent spawn,
splits/rename, automations, artifacts, eval/console/network/cookies, hover/select/check/upload,
computer. `orca_tabs` owns tab-surface management; `orca_terminal`/`orca_browser` own
interaction with one session.

## orca_subagent flow

1. Validate `profile` by name against global (`~/.pi/agent/profiles/`) and trusted project
   (`.pi/agent/profiles/`) dirs; fail with closest available names if unknown (prevents a
   silently profile-less child).
2. Resolve worktree: `active` (default) / `worktree create --name <slug>` for `"new"` /
   pass-through selector.
3. `terminal create --worktree <wt> --title <title || slug> --command "pi --agent-profile <profile>" --json`
   → `startupTerminal.handle` is the sole agent handle.
4. `terminal wait --for tui-idle --timeout-ms 60000`; only send when `satisfied: true`
   (retry once with a larger timeout, else report "not started").
5. `terminal send --terminal <h> --text <task> --enter --wait-submit 30 --json`; treat
   `turn_started` as proof of dispatch.
6. `wait: true` → loop `terminal wait --for tui-idle --timeout-ms 3000`, emitting progress
   each round, until idle / `timeout_seconds` (default 600) / abort; then `terminal read`
   tail. Otherwise return handle + hint to poll with `orca_terminal`.

## pi-agent-profiles change (`../pi-agent-profiles`)

Goal: profiles without `agentProfile: true` (e.g. `subagentProfile: true` reviewer/scout
profiles) become usable by exact name; `agentProfile` only controls picker visibility and
default-fallback eligibility.

- `controller.ts`: `activate(name, opts?: { allowIneligible?: boolean })`. `usable` always
  applies; `ineligible` applies only when explicitly named; `invalid`/unknown always fail
  (distinct message: "not main-agent eligible").
- Explicit paths pass `allowIneligible: true`: `/agent <name>`, `--agent-profile <name>`,
  restore-from-branch. The persisted cwd/last default fallback keeps `false` so a subagent
  profile never auto-applies to a fresh interactive session.
- `getProfileSummaries()` unchanged → picker still hides non-`agentProfile` profiles.
- README wording + tests (controller, command, extension) updated.

## Repo layout (`~/Documents/software/pi-orca`)

```
package.json      # pi.extensions: ["./src/index.ts"], vp check/test, oxfmt/oxlint
tsconfig.json
PLAN.md  README.md
src/
  index.ts        # registerTool ×4, promptSnippet/promptGuidelines
  orca-cli.ts     # binary resolution (ORCA_CLI_COMMAND → orca-dev → orca-ide → orca shim),
                  #   runOrca(args, {timeoutMs, signal}) with --json parsing + typed errors
  profiles.ts     # lightweight profile-name scan for spawn validation
  truncate.ts     # shared output caps (read/snapshot tails)
  tools/{subagent,terminal,tabs,browser}.ts
test/             # vitest: arg building, JSON parsing, error mapping, profile scan
scripts/smoke.ts  # live smoke vs running Orca (terminal list/read, browser goto/snapshot)
```

## Implementation order

1. pi-agent-profiles: activate opts + callers + tests + README.
2. Scaffold pi-orca; `orca-cli.ts` resolver/runner + unit tests.
3. `orca_terminal`, `orca_tabs`, `orca_browser` (+ tests), smoke against live Orca (v1.4.201 running).
4. `orca_subagent` (+ tests), e2e: spawn a real `subagentProfile: true` profile in Orca.
5. `pi install .`, verify in a real pi session; README.

## Risks / notes

- tui-idle is a heuristic; `wait: true` returns the output tail + handle so the parent can judge.
- `worktree create` without `--agent` may open a fallback shell (custom-argv two-step path);
  we never auto-close tabs, only report.
- Never execute bare `orca` on Linux outside Orca (screen reader) — resolver mirrors the skill.
- Terminal reads are capped/truncated; snapshot output bounded.
