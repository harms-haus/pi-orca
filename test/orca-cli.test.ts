import { describe, expect, it } from "vitest";
import {
  OrcaCliError,
  resolveOrcaCommand,
  runOrca,
  splitCommand,
  type OrcaExec,
} from "../src/orca-cli.js";

const okExec =
  (stdout: string): OrcaExec =>
  async () => ({ stdout, stderr: "" });

describe("splitCommand", () => {
  it("splits on unquoted whitespace and honors quotes", () => {
    expect(splitCommand("/path/with spaces/orca")).toEqual(["/path/with", "spaces/orca"]);
    expect(splitCommand('"/path/with spaces/orca"')).toEqual(["/path/with spaces/orca"]);
    expect(splitCommand('"/path/with spaces/orca" --flag')).toEqual([
      "/path/with spaces/orca",
      "--flag",
    ]);
    expect(splitCommand("/bin/orca --host 'my host'")).toEqual(["/bin/orca", "--host", "my host"]);
    expect(splitCommand("orca\\\\bin")).toEqual(["orca\\bin"]);
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("resolveOrcaCommand", () => {
  it("prefers ORCA_CLI_COMMAND, then orca-dev, then platform defaults", () => {
    expect(resolveOrcaCommand({ ORCA_CLI_COMMAND: '"/custom orca"' })).toEqual(["/custom orca"]);
    expect(resolveOrcaCommand({ ORCA_DEV_REPO_ROOT: "/dev" })).toEqual(["orca-dev"]);
    expect(resolveOrcaCommand({}, () => "linux")).toEqual(["orca-ide"]);
    expect(resolveOrcaCommand({}, () => "darwin")).toEqual(["orca"]);
  });
});

describe("runOrca", () => {
  it("appends --json and returns the parsed result", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec: OrcaExec = async (command, args) => {
      calls.push({ command, args });
      return { stdout: JSON.stringify({ ok: true, result: { terminals: [1] } }), stderr: "" };
    };
    const result = await runOrca(["terminal", "list"], { exec });
    expect(result).toEqual({ terminals: [1] });
    expect(calls[0]).toMatchObject({ command: "orca-ide", args: ["terminal", "list", "--json"] });
  });

  it("maps a non-ok envelope to a failed OrcaCliError", async () => {
    const error = await runOrca(["tab", "close"], {
      exec: okExec(JSON.stringify({ ok: false, error: { message: "no such tab" } })),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrcaCliError);
    expect((error as OrcaCliError).kind).toBe("failed");
    expect((error as OrcaCliError).message).toContain("no such tab");
  });

  it("maps non-JSON output to a failed error carrying the tail", async () => {
    const error = await runOrca(["snapshot"], { exec: okExec("boom") }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OrcaCliError);
    expect((error as OrcaCliError).stderr).toBe("boom");
  });

  it("classifies missing binaries as unavailable", async () => {
    const exec: OrcaExec = async () => {
      throw Object.assign(new Error("spawn fail"), { code: "ENOENT" });
    };
    const error = await runOrca(["status"], { exec }).catch((caught: unknown) => caught);
    expect((error as OrcaCliError).kind).toBe("unavailable");
    expect((error as OrcaCliError).message).toContain("ORCA_CLI_COMMAND");
  });

  it("propagates aborts as failures", async () => {
    const exec: OrcaExec = async () => {
      throw Object.assign(new Error("aborted"), { killed: true });
    };
    const error = await runOrca(["terminal", "wait"], { exec }).catch((caught: unknown) => caught);
    expect((error as OrcaCliError).kind).toBe("failed");
    expect((error as OrcaCliError).message).toContain("aborted");
  });
});
