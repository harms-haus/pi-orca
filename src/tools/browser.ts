import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runOrca } from "../orca-cli.js";
import { clipHead, orcaErrorMessage, renderResult, textResult } from "../util.js";

/**
 * Driving Orca's embedded browser. The interaction model mirrors Playwright:
 * snapshot the accessibility tree, act on @eN refs, re-snapshot. Console,
 * network, cookies, eval, and profile management stay on the orca CLI.
 */

export interface OrcaBrowserDeps {
  runOrca?: typeof runOrca;
}

const ACTIONS = [
  "open",
  "goto",
  "back",
  "reload",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "type",
  "key",
  "scroll",
  "wait",
  "close",
] as const;

export interface BrowserActionPlan {
  args: string[];
  /** Action-specific validation error, when parameters are incomplete. */
  error: string | undefined;
}

/**
 * Map tool params to orca argv. Pure so tests cover every action without a
 * live browser.
 */
export function buildBrowserArgs(params: {
  action: (typeof ACTIONS)[number];
  url?: string;
  ref?: string;
  value?: string;
  text?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  selector?: string;
  load_state?: "load" | "domcontentloaded" | "networkidle";
  timeout_ms?: number;
  index?: number;
  format?: "png" | "jpeg";
}): BrowserActionPlan {
  const { action } = params;
  switch (action) {
    case "open": {
      if (!params.url) return { args: [], error: "open requires `url`" };
      return {
        args: ["tab", "create", "--url", params.url],
        error: undefined,
      };
    }
    case "goto": {
      if (!params.url) return { args: [], error: "goto requires `url`" };
      return { args: ["goto", "--url", params.url], error: undefined };
    }
    case "back":
      return { args: ["back"], error: undefined };
    case "reload":
      return { args: ["reload"], error: undefined };
    case "snapshot":
      return { args: ["snapshot"], error: undefined };
    case "screenshot":
      return {
        args: ["screenshot", ...(params.format ? ["--format", params.format] : [])],
        error: undefined,
      };
    case "click": {
      if (!params.ref) return { args: [], error: "click requires `ref` from a snapshot (e.g. e3)" };
      return { args: ["click", "--element", params.ref], error: undefined };
    }
    case "fill": {
      if (!params.ref || params.value === undefined)
        return { args: [], error: "fill requires `ref` and `value`" };
      return {
        args: ["fill", "--element", params.ref, "--value", params.value],
        error: undefined,
      };
    }
    case "type": {
      if (params.text === undefined) return { args: [], error: "type requires `text`" };
      return { args: ["type", "--input", params.text], error: undefined };
    }
    case "key": {
      if (!params.key) return { args: [], error: "key requires `key` (e.g. Enter, Tab, Escape)" };
      return { args: ["keypress", "--key", params.key], error: undefined };
    }
    case "scroll": {
      if (!params.direction) return { args: [], error: "scroll requires `direction`" };
      return {
        args: [
          "scroll",
          "--direction",
          params.direction,
          ...(params.amount !== undefined ? ["--amount", String(Math.round(params.amount))] : []),
        ],
        error: undefined,
      };
    }
    case "wait": {
      if (
        !params.selector &&
        !params.text &&
        !params.url &&
        !params.load_state &&
        params.timeout_ms === undefined
      ) {
        return {
          args: [],
          error: "wait requires at least one of selector/text/url/load_state/timeout_ms",
        };
      }
      return {
        args: [
          "wait",
          ...(params.selector ? ["--selector", params.selector] : []),
          ...(params.text ? ["--text", params.text] : []),
          ...(params.url ? ["--url", params.url] : []),
          ...(params.load_state ? ["--load", params.load_state] : []),
          ...(params.timeout_ms !== undefined
            ? ["--timeout", String(Math.round(params.timeout_ms))]
            : []),
        ],
        error: undefined,
      };
    }
    case "close": {
      if (params.index === undefined)
        return {
          args: [],
          error: "close requires `index` (0-based, from orca_tabs action=list)",
        };
      return { args: ["tab", "close", "--index", String(params.index)], error: undefined };
    }
  }
}

interface ImagePayload {
  data?: string;
  mimeType?: string;
  mime_type?: string;
  image?: string;
  base64?: string;
}

/** Extract a base64 image from a screenshot result, if the host provides one. */
export function extractImage(result: unknown): { data: string; mimeType: string } | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const candidate: ImagePayload =
    (result as { screenshot?: ImagePayload }).screenshot ?? (result as ImagePayload);
  const data = candidate.data ?? candidate.base64 ?? candidate.image;
  if (typeof data !== "string" || data.length === 0) return undefined;
  const mimeType =
    candidate.mimeType ??
    candidate.mime_type ??
    (data.startsWith("iVBOR") ? "image/png" : "image/jpeg");
  return { data, mimeType };
}

export function registerOrcaBrowserTool(pi: ExtensionAPI, deps: OrcaBrowserDeps = {}): void {
  const run = deps.runOrca ?? runOrca;

  pi.registerTool({
    name: "orca_browser",
    label: "Orca Browser",
    description:
      "Drive Orca's embedded browser: open/goto pages, snapshot the accessibility tree, and act on " +
      "@eN element refs. Core loop: snapshot → click/fill/type by ref → re-snapshot (refs go stale " +
      "after navigation or tab switches). Covers the visible IDE browser; use bash + the orca CLI for " +
      "eval, console, network, cookies, and profiles.",
    promptSnippet: "Drive Orca's embedded browser (snapshot → act on @eN refs → re-snapshot)",
    promptGuidelines: [
      "Use orca_browser action=snapshot before acting; refs from an old snapshot break after navigation or orca_tabs switch.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      url: Type.Optional(Type.String({ description: "open/goto: target URL" })),
      ref: Type.Optional(
        Type.String({ description: "click/fill: element ref from snapshot (e.g. e3)" }),
      ),
      value: Type.Optional(Type.String({ description: "fill: value to set" })),
      text: Type.Optional(
        Type.String({ description: "type: text for current focus; wait: text to await" }),
      ),
      key: Type.Optional(Type.String({ description: "key: Enter, Tab, Escape, ArrowDown, …" })),
      direction: Type.Optional(
        StringEnum(["up", "down", "left", "right"] as const, { description: "scroll direction" }),
      ),
      amount: Type.Optional(Type.Number({ description: "scroll: pixels" })),
      selector: Type.Optional(Type.String({ description: "wait: CSS selector to await" })),
      load_state: Type.Optional(
        StringEnum(["load", "domcontentloaded", "networkidle"] as const, {
          description: "wait: load state to await",
        }),
      ),
      timeout_ms: Type.Optional(Type.Number({ description: "wait: timeout in ms" })),
      index: Type.Optional(Type.Number({ description: "close: 0-based browser tab index" })),
      format: Type.Optional(
        StringEnum(["png", "jpeg"] as const, { description: "screenshot format" }),
      ),
    }),

    async execute(_id, params, signal) {
      const plan = buildBrowserArgs(params);
      if (plan.error !== undefined) throw new Error(plan.error);
      const runOptions = signal ? { signal } : {};
      try {
        const result = await run(plan.args, runOptions);
        if (params.action === "screenshot") {
          const image = extractImage(result);
          if (image) {
            return {
              content: [{ type: "image", data: image.data, mimeType: image.mimeType }],
              details: {},
            };
          }
        }
        const text =
          params.action === "snapshot" ? clipHead(renderResult(result)) : renderResult(result);
        return textResult(text, {
          action: params.action,
          ...(params.action === "open" || params.action === "goto"
            ? { url: params.url ?? "" }
            : {}),
        });
      } catch (error) {
        throw new Error(orcaErrorMessage(error));
      }
    },
  });
}
