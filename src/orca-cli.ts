import { execFile } from "node:child_process";
import { platform } from "node:os";

/**
 * Single execution seam for the Orca CLI. Every tool funnels through here so
 * binary resolution, --json envelope parsing, and error classification stay in
 * one place and stay testable without a live Orca.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type OrcaExec = (
  command: string,
  args: string[],
  options: { timeout: number; signal?: AbortSignal; cwd?: string; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: OrcaExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeout,
        killSignal: "SIGKILL",
        signal: options.signal,
        cwd: options.cwd,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });

export class OrcaCliError extends Error {
  /** "unavailable": Orca or its CLI cannot be reached at all. */
  readonly kind: "unavailable" | "failed";
  readonly stderr?: string;
  /** Machine code from the envelope's error object (e.g. "timeout"). */
  readonly code?: string;

  constructor(kind: "unavailable" | "failed", message: string, stderr?: string, code?: string) {
    super(message);
    this.name = "OrcaCliError";
    this.kind = kind;
    if (stderr) this.stderr = stderr;
    if (code) this.code = code;
  }
}

/**
 * Split $ORCA_CLI_COMMAND on unquoted whitespace. The value is argv0-style
 * ("may contain spaces, args"), so quotes and backslash escapes are honored
 * rather than relying on a shell.
 */
export function splitCommand(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
      started = true;
      continue;
    }
    if (quote !== undefined && char === quote) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && /\s/.test(char)) {
      if (started) parts.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started && (current || quote !== undefined)) parts.push(current);
  return parts;
}

/**
 * Resolution order mirrors the orca CLI guide:
 * $ORCA_CLI_COMMAND → $ORCA_DEV_REPO_ROOT + orca-dev → orca-ide (Linux,
 * outside Orca, where bare `orca` is the screen reader) → bare `orca`
 * (macOS, and Linux terminals managed by Orca, where the shim applies).
 */
export function resolveOrcaCommand(
  env: NodeJS.ProcessEnv = process.env,
  osPlatform: () => string = platform,
): string[] {
  const explicit = env.ORCA_CLI_COMMAND?.trim();
  if (explicit) return splitCommand(explicit);
  if (env.ORCA_DEV_REPO_ROOT) return ["orca-dev"];
  if (osPlatform() === "linux") return ["orca-ide"];
  return ["orca"];
}

interface OrcaEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: unknown;
}

function envelopeErrorCode(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null) {
    const code = (value as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      if (typeof record[key] === "string") return record[key];
    }
  }
  return undefined;
}

function classifyExecError(error: unknown, argv0: string, args: string[]): OrcaCliError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new OrcaCliError(
      "unavailable",
      `Orca CLI '${argv0}' not found. Is Orca installed and on PATH? ` +
        "Set ORCA_CLI_COMMAND to override.",
    );
  }
  if ((error as { killed?: boolean }).killed || code === "ABORT_ERR") {
    return new OrcaCliError("failed", `orca ${args[0] ?? ""} timed out or was aborted`);
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  return new OrcaCliError(
    "failed",
    `orca ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
    typeof stderr === "string" ? stderr : undefined,
  );
}

export interface OrcaRunOptions {
  /** Wall-clock cap for the child process. Wait commands set their own. */
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Treat an envelope {code:"timeout"} error as a normal result (undefined). */
  timeoutOk?: boolean;
  /** Test seam. */
  exec?: OrcaExec;
}

/** Run an orca subcommand with --json and return the parsed `result`. */
export async function runOrca(args: string[], options: OrcaRunOptions = {}): Promise<unknown> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prefix = resolveOrcaCommand();
  const argv = [...prefix, ...args, "--json"];
  let stdout = "";
  try {
    ({ stdout } = await exec(argv[0]!, argv.slice(1), {
      timeout: timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      maxBuffer: MAX_BUFFER_BYTES,
    }));
  } catch (error) {
    // Wait-style commands exit non-zero on timeout while still emitting a
    // valid envelope on stdout — parse it before classifying as a failure.
    const captured = (error as { stdout?: unknown }).stdout;
    if (typeof captured !== "string" || captured.trim() === "") {
      throw classifyExecError(error, prefix[0] ?? "orca", args);
    }
    stdout = captured;
  }

  let envelope: OrcaEnvelope;
  try {
    envelope = JSON.parse(stdout) as OrcaEnvelope;
  } catch {
    throw new OrcaCliError(
      "failed",
      `orca ${args.join(" ")} returned non-JSON output`,
      stdout.slice(-2000),
    );
  }
  if (!envelope.ok) {
    const code = envelopeErrorCode(envelope.error);
    if (options.timeoutOk && code === "timeout") return undefined;
    throw new OrcaCliError(
      "failed",
      errorMessage(envelope.error) ?? `orca ${args.join(" ")} failed`,
      undefined,
      code,
    );
  }
  return envelope.result;
}
