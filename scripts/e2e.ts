/** End-to-end: one trivial subagent run through runSubagent (the tool path). */
import { runSubagent } from "../src/tools/subagent.js";

const outcome = await runSubagent(
  {
    profile: "code-quality-reviewer",
    task: "Reply with exactly E2E-OK and nothing else. Do not read any files or run any commands.",
    title: "pi-orca-e2e",
    wait: true,
    timeout_seconds: 240,
  },
  {
    readinessTimeoutsMs: { first: 60_000, retry: 90_000 },
    onUpdate: (text) => console.log(`[progress] ${text}`),
  },
);
console.log(`\nstatus: ${outcome.details.status}`);
console.log(outcome.text);
if (outcome.details.status !== "completed") process.exit(1);
if (!outcome.text.includes("E2E-OK")) {
  console.error("missing E2E-OK marker in output");
  process.exit(1);
}
