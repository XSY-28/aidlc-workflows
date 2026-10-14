// covers: function:retiredRowLine, function:retiredRow, function:retiredRowDoctorCheck, function:harnessArgsAsIds, tool:aidlc-doctor
//
// AI-DLC no longer ships the legacy Kiro CLI row (`kiro`, agent-v1 JSON
// agents on Kiro CLI's v2 engine); the Kiro row (`kiro-ide`) serves Kiro IDE
// and Kiro CLI on its v3 engine, and `--harness kiro` names it. A project
// still on the legacy row is told what to do: config stops before it writes
// anything and doctor fails one row, both with the same line. (The first-run
// picker is t299.)
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { harnessArgsAsIds, harnessArgsAsTyped, retiredRow, retiredRowLine } from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(120_000);

const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DOCTOR = join(REPO_ROOT, "core", "tools", "aidlc-doctor.ts");
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const RELEASE = join(REPO_ROOT, "dist-release");
const HOST_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "KIRO_SESSION_ID", "OPENCODE",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "AIDLC_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_COMPILED_EXECUTABLE", "AIDLC_TEST_CONFIG_DETECTION_JSON",
  "AIDLC_CONFIG_HARNESS_IDS", "AIDLC_CONFIG_HANDOFF",
];
const LINE = (command: string) =>
  ".kiro is set up for the legacy Kiro CLI row, which AI-DLC no longer ships. Move .kiro aside " +
  `(for example to .kiro.old), run \`${command}\`, then copy your own files (steering, MCP settings) back from it. ` +
  "aidlc/ is kept.";

// The line as config and doctor print it, in whatever command form they run.
const SAID = /\.kiro is set up for the legacy Kiro CLI row, which AI-DLC no longer ships\. Move \.kiro aside \(for example to \.kiro\.old\), run `[^`]* config --harness kiro(?: --project-dir [^`]*)?`, then copy your own files \(steering, MCP settings\) back from it\. aidlc\/ is kept\./;

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !HOST_ENV.includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

function fresh(): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-")));
  temporary.push(project);
  mkdirSync(join(project, ".git"));
  return project;
}

// What an install of the legacy row left: its stamp names the row, beside its
// JSON conductor and a record of work.
function legacyProject(): string {
  const project = fresh();
  mkdirSync(join(project, ".kiro", "tools", "data"), { recursive: true });
  mkdirSync(join(project, ".kiro", "agents"), { recursive: true });
  mkdirSync(join(project, "aidlc", "spaces", "default"), { recursive: true });
  writeFileSync(
    join(project, ".kiro", "tools", "data", "aidlc-stamp.json"),
    `${JSON.stringify({ schemaVersion: 1, harnessDir: ".kiro", distribution: "kiro", frameworkVersion: "2.11.0" })}\n`,
  );
  writeFileSync(join(project, ".kiro", "agents", "aidlc.json"), "{}\n");
  writeFileSync(join(project, "aidlc", "spaces", "default", "notes.md"), "kept\n");
  return project;
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path, "utf-8");
    }
  };
  walk(root);
  return files;
}

function run(tool: string, args: string[], cwd: string, extra: Record<string, string> = {}, input?: string) {
  const result = spawnSync(process.execPath, [tool, ...args], { cwd, env: childEnv(extra), encoding: "utf-8", input });
  if (result.error) throw result.error;
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("the legacy Kiro CLI row AI-DLC no longer ships", () => {
  test("one record names it, and one line says what to do", () => {
    expect(retiredRow("kiro")).toBe(true);
    for (const row of ["kiro-ide", "claude", "codex", "copilot", "cursor", "opencode"]) expect(retiredRow(row)).toBe(false);
    const tree = { root: "/p/.kiro", harnessDir: ".kiro", distribution: "kiro" };
    expect(retiredRowLine(tree, "aidlc", "")).toBe(LINE("aidlc config --harness kiro"));
    expect(retiredRowLine(tree, "bun .claude/tools/aidlc.ts", " --project-dir /p")).toBe(
      LINE("bun .claude/tools/aidlc.ts config --harness kiro --project-dir /p"),
    );
  });

  test("config on a legacy project says the line and writes nothing, however it is run", () => {
    const project = legacyProject();
    const before = snapshot(project);
    for (const args of [
      ["config", "--yes"],
      ["config", "--dry-run"],
      ["config", "--harness", "kiro", "--from", join(RELEASE, "kiro-ide"), "--mcp", "none", "--yes"],
      ["config", "--harness", "claude", "--from", join(RELEASE, "claude"), "--mcp", "none", "--yes"],
    ]) {
      const result = run(INIT, args, project);
      expect(result.status, result.out).toBe(2);
      expect(result.out.replace(/\s+/g, " "), args.join(" ")).toMatch(SAID);
      expect(snapshot(project)).toEqual(before);
    }
    // At a terminal, before any question.
    const asked = run(INIT, ["config"], project, { AIDLC_TEST_CONFIG_TTY: "1" }, "");
    expect(asked.status, asked.out).toBe(2);
    expect(asked.out).not.toContain("[y/N]");
    expect(snapshot(project)).toEqual(before);
    // From another folder, the step names the project.
    const elsewhere = run(INIT, ["config", "--project-dir", project, "--yes"], tmpdir());
    expect(elsewhere.out.replace(/\s+/g, " ")).toContain(`config --harness kiro --project-dir ${project}\``);
  });

  test("once .kiro is moved aside, --harness kiro sets the Kiro row up and keeps aidlc/", () => {
    const project = legacyProject();
    renameSync(join(project, ".kiro"), join(project, ".kiro.old"));
    const result = run(INIT, ["config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none", "--yes"], project);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(project, ".kiro", "agents", "aidlc-aidlc.md"))).toBe(true);
    expect(readFileSync(join(project, "aidlc", "spaces", "default", "notes.md"), "utf-8")).toBe("kept\n");
  });

  test("doctor fails the legacy project with the same line, and says nothing of it on the Kiro row", () => {
    const project = legacyProject();
    const here = run(DOCTOR, ["--project-dir", project], project);
    expect(here.out.replace(/\s+/g, " ")).toMatch(SAID);
    expect(here.out).toMatch(/fail\s+\.kiro is set up for the legacy Kiro CLI row/);
    const elsewhere = run(DOCTOR, ["--project-dir", project], tmpdir());
    expect(elsewhere.out.replace(/\s+/g, " ")).toContain(`config --harness kiro --project-dir ${project}\``);

    const kiro = fresh();
    const set = run(INIT, ["config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none", "--yes"], kiro);
    expect(set.status, set.out).toBe(0);
    expect(run(DOCTOR, ["--project-dir", kiro], kiro).out).not.toContain("legacy Kiro CLI row");
  });

  // The names a person types: `kiro` is the Kiro row (id kiro-ide); the earlier
  // `kiro-ide` says what to type instead and writes nothing.
  test("--harness kiro sets up the Kiro row and says the versions it runs in; kiro-ide says to type kiro", () => {
    const kiro = fresh();
    const set = run(INIT, ["config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none", "--yes"], kiro);
    expect(set.status, set.out).toBe(0);
    expect(set.out).toContain(
      "Note: AI-DLC's Kiro row runs in Kiro IDE 1.1.70 or later and in Kiro CLI 2.24.1 or later; older versions are not supported.",
    );
    expect(existsSync(join(kiro, ".kiro", "agents", "aidlc-aidlc.md"))).toBe(true);

    const earlier = fresh();
    const named = run(INIT, ["config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro-ide", "--mcp", "none", "--yes"], earlier);
    expect(named.status).not.toBe(0);
    expect(named.out).toContain("`kiro-ide` is now called `kiro`");
    expect(named.out).toContain(" --harness kiro --mcp none --yes\n");
    expect(existsSync(join(earlier, ".kiro"))).toBe(false);
  });

  test("a config line reads typed names as row ids, wherever the launcher's options stand, and prints them back typed", () => {
    expect(harnessArgsAsIds(["models", "--harness", "kiro", "--project"])).toEqual({
      args: ["models", "--harness", "kiro-ide", "--project"],
    });
    expect(harnessArgsAsIds(["--harness", "kiro-ide", "--yes"]).retired).toEqual({
      typed: "kiro-ide",
      instead: "kiro",
      args: ["--harness", "kiro", "--yes"],
    });
    expect(harnessArgsAsTyped(["--harness", "kiro-ide", "--harness", "claude"])).toEqual(["--harness", "kiro", "--harness", "claude"]);

    const project = fresh();
    // The launcher's own option ahead of `config` reads the line the same way.
    for (const lead of [["config", "--project-dir", project], ["--project-dir", project, "config"]]) {
      const result = run(DISPATCHER, [...lead, "--harness", "kiro-ide", "--mcp", "none"], project);
      expect(result.status, result.out).not.toBe(0);
      expect(result.out, lead.join(" ")).toContain("`kiro-ide` is now called `kiro`");
    }
  });

  // With this machine's Kiro CLI older than the Kiro row needs, a person at a
  // terminal is asked first, and No says how to go on; --yes says so and goes on.
  test.skipIf(process.platform === "win32")("--harness kiro with an older Kiro CLI asks first at a terminal, and --yes says so", () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-bin-")));
    temporary.push(bin);
    writeFileSync(join(bin, "kiro-cli"), "#!/bin/sh\necho 'kiro-cli 2.20.0'\n");
    chmodSync(join(bin, "kiro-cli"), 0o755);
    const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, ...extra });
    const older =
      "Kiro CLI 2.20.0 is older than 2.24.1. AI-DLC's Kiro row works in Kiro CLI 2.24.1 or later (and in Kiro IDE 1.1.70 or later).";
    const project = fresh();
    const args = ["config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none"];
    const asked = run(INIT, args, project, env({ AIDLC_TEST_CONFIG_TTY: "1" }), "n\n");
    const said = asked.out.replace(/\s+/g, " ");
    expect(said).toContain(`${older} Set up anyway? [y/N]:`);
    expect(said).toMatch(/Nothing written\. Update Kiro CLI to 2\.24\.1 or later, then run `[^`]* config` again\./);
    expect(existsSync(join(project, ".kiro"))).toBe(false);

    const went = run(INIT, [...args, "--yes"], project, env());
    expect(went.status, went.out).toBe(0);
    expect(went.out).toContain(`Note: ${older}`);
    expect(existsSync(join(project, ".kiro", "agents", "aidlc-aidlc.md"))).toBe(true);
  });
});
