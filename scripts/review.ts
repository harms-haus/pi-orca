/**
 * Dogfood run: spawn a real subagent through the orca_subagent flow.
 *
 *   pnpm exec jiti scripts/review.ts [profile]
 *
 * Defaults to the code-quality-reviewer profile — a subagentProfile: true
 * profile that is only selectable because of the pi-agent-profiles change.
 */
import { runSubagent } from "../src/tools/subagent.js";

const profile = process.argv[2] ?? "code-quality-reviewer";
const task = [
  "Review the pi extension source in /home/blake/Documents/software/pi-orca.",
  "Scope: src/orca-cli.ts, src/profiles.ts, src/util.ts, src/index.ts, src/tools/*.ts.",
  "Read the files directly. Report code quality issues only: correctness bugs,",
  "unclear structure, error-handling gaps, and naming problems. For each finding",
  "give file:line, severity (high/medium/low), and a one-line suggested fix.",
  "End with a verdict line: SHIP or FIX FIRST, with the reason.",
].join(" ");

const outcome = await runSubagent(
  {
    profile,
    task,
    title: "pi-orca-review",
    wait: true,
    timeout_seconds: 540,
  },
  {
    readinessTimeoutsMs: { first: 60_000, retry: 90_000 },
    onUpdate: (text) => console.log(`[progress] ${text}`),
  },
);

console.log(`\n=== result (status: ${outcome.details.status}) ===`);
console.log(outcome.text);
