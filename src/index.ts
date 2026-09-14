import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrcaBrowserTool, type OrcaBrowserDeps } from "./tools/browser.js";
import { registerOrcaSubagentTool, type OrcaSubagentDeps } from "./tools/subagent.js";
import { registerOrcaTabsTool, type OrcaTabsDeps } from "./tools/tabs.js";
import { registerOrcaTerminalTool, type OrcaTerminalDeps } from "./tools/terminal.js";

export interface OrcaToolsOptions
  extends OrcaSubagentDeps, OrcaTerminalDeps, OrcaTabsDeps, OrcaBrowserDeps {}

/** Register all Orca tools against the host Pi runtime. */
export function registerOrcaTools(pi: ExtensionAPI, options: OrcaToolsOptions = {}): void {
  const runOrca = options.runOrca;
  const deps = runOrca ? { runOrca } : {};
  registerOrcaSubagentTool(pi, {
    ...deps,
    ...(options.validateProfile ? { validateProfile: options.validateProfile } : {}),
    ...(options.readinessTimeoutsMs ? { readinessTimeoutsMs: options.readinessTimeoutsMs } : {}),
    ...(options.sendProbe ? { sendProbe: options.sendProbe } : {}),
  });
  registerOrcaTerminalTool(pi, deps);
  registerOrcaTabsTool(pi, deps);
  registerOrcaBrowserTool(pi, deps);
}

export default registerOrcaTools;
