// covers: function:retiredRowLine, function:rowNewProjectsGet, function:retiredRowDoctorCheck, tool:aidlc-doctor
//
// New projects are no longer offered the legacy Kiro CLI row (`kiro`, agent-v1);
// the kiro-ide row serves Kiro CLI on its 3.0 engine and Kiro IDE. A project
// that has the legacy row keeps it: a config refresh and doctor say how to
// move it. A run that puts a project on that row, and a project on any other
// row, hear nothing of it. (The first-run picker is t299.)
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { harnessArgsAsIds, harnessArgsAsTyped, retiredRowLine, rowNewProjectsGet } from "../../core/tools/aidlc-runtime-paths.ts";
import { typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";

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
];
const STANDS = "AI-DLC now sets new projects up on the `kiro` row; this project is on the legacy `kiro-cli-legacy` row, which keeps working.";
const MOVE = "To move it to `kiro`, which runs in Kiro IDE and in Kiro CLI 2.24.1 or later on its v3 engine, run `aidlc config --harness kiro`.";

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

function install(harness: "kiro" | "kiro-ide"): { project: string; out: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-")));
  temporary.push(project);
  mkdirSync(join(project, ".git"));
  const result = spawnSync(
    process.execPath,
    [INIT, "config", "--from", join(RELEASE, harness), "--harness", typedHarnessName(harness), "--mcp", "none", "--yes"],
    { cwd: project, env: childEnv(), encoding: "utf-8" },
  );
  if (result.error) throw result.error;
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  expect(result.status, out).toBe(0);
  return { project, out };
}

describe("the legacy kiro row new projects no longer get", () => {
  test("one rule names it, the row new projects get instead, and the line that moves a project", () => {
    expect(rowNewProjectsGet("kiro")).toBe("kiro-ide");
    for (const row of ["kiro-ide", "claude", "codex", "copilot", "cursor", "opencode"]) {
      expect(rowNewProjectsGet(row)).toBeNull();
      expect(retiredRowLine(row, "aidlc", "", undefined)).toBeNull();
    }
    expect(retiredRowLine("kiro", "aidlc", "", "2.24.1")).toBe(`${STANDS} ${MOVE}`);
    // A copied project's tool, named for a run from another folder.
    expect(retiredRowLine("kiro", "bun .kiro/tools/aidlc.ts", " --project-dir /p", "2.24.1")).toContain(
      "run `bun .kiro/tools/aidlc.ts config --harness kiro --project-dir /p`.",
    );
  });

  // A runtime root holding some rows only, as an explicit AIDLC_RUNTIME_ROOT can.
  function runtimeOf(rows: readonly string[]): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-runtime-")));
    temporary.push(root);
    // A junction on Windows needs no symbolic-link privilege.
    for (const row of rows) symlinkSync(join(RELEASE, row), join(root, row), process.platform === "win32" ? "junction" : "dir");
    return root;
  }

  test("unnamed, config still refuses to choose between two installed rows, and offers the legacy row only without kiro-ide", () => {
    const configIn = (root: string): string => {
      const project = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-")));
      temporary.push(project);
      mkdirSync(join(project, ".git"));
      const result = spawnSync(process.execPath, [INIT, "config", "--yes"], {
        cwd: project,
        // An empty install root: only the runtime root's rows are installed.
        env: childEnv({ AIDLC_RUNTIME_ROOT: root, AIDLC_INSTALL_ROOT: join(project, ".no-install") }),
        encoding: "utf-8",
      });
      expect(result.status).not.toBe(0);
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    };
    expect(configIn(runtimeOf(["kiro", "kiro-ide"]))).toContain("multiple harnesses are installed; pass --harness <kiro>");
    expect(configIn(runtimeOf(["claude", "kiro"]))).toContain("multiple harnesses are installed; pass --harness <claude|kiro-cli-legacy>");
  });

  test("config tells a legacy project how to move it on a refresh, not the run that chose the row, and nothing on kiro-ide", () => {
    const legacy = install("kiro");
    // Naming the row is the person's choice: that run does not argue with it.
    expect(legacy.out).not.toContain("now sets new projects up");
    expect(existsSync(join(legacy.project, ".kiro", "agents", "aidlc.json"))).toBe(true);
    const refresh = (extra: string[]) => {
      const result = spawnSync(process.execPath, [INIT, "config", "--from", join(RELEASE, "kiro"), "--yes", ...extra], {
        cwd: legacy.project,
        env: childEnv(),
        encoding: "utf-8",
      });
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, out).toBe(0);
      return out;
    };
    // A preview says what the run says, and naming the row, as the Kiro CLI
    // guide does, refreshes it like any run; the row stays.
    expect(refresh(["--dry-run"])).toContain(`Note: ${STANDS} To move it to \`kiro\``);
    expect(refresh(["--harness", "kiro-cli-legacy"])).toContain(`Note: ${STANDS} To move it to \`kiro\``);
    expect(refresh([])).toContain(`Note: ${STANDS} To move it to \`kiro\``);
    expect(existsSync(join(legacy.project, ".kiro", "agents", "aidlc.json"))).toBe(true);

    expect(install("kiro-ide").out).not.toContain("now sets new projects up");

    // Nor does a preview of a new install.
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-")));
    temporary.push(fresh);
    mkdirSync(join(fresh, ".git"));
    const preview = spawnSync(
      process.execPath,
      [INIT, "config", "--from", join(RELEASE, "kiro"), "--harness", "kiro-cli-legacy", "--mcp", "none", "--dry-run"],
      { cwd: fresh, env: childEnv(), encoding: "utf-8" },
    );
    const previewed = `${preview.stdout ?? ""}${preview.stderr ?? ""}`;
    expect(preview.status, previewed).toBe(0);
    expect(previewed).toContain("plan for");
    expect(previewed).not.toContain("now sets new projects up");
  });

  test("doctor shows the line on a legacy project as passing, not a warning, and says nothing of it elsewhere", () => {
    const doctor = (project: string, cwd = project): string => {
      const result = spawnSync(process.execPath, [DOCTOR, "--project-dir", project], {
        cwd,
        env: childEnv(),
        encoding: "utf-8",
      });
      if (result.error) throw result.error;
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    };
    const legacyProject = install("kiro").project;
    const legacy = doctor(legacyProject);
    // Shown without --verbose, and counted as passed: a team may stay on purpose.
    expect(legacy).toMatch(
      /\n {2}ok {4}AI-DLC now sets new projects up on the `kiro` row; this project is on the legacy `kiro-cli-legacy` row, which keeps working\. To move it to `kiro`, which runs in Kiro IDE and in Kiro CLI 2\.24\.1 or later on its v3 engine, run `[^`\n]* config --harness kiro`\.\n/,
    );
    expect(legacy).not.toContain("warn  AI-DLC now sets new projects up");
    // Run from another folder, the step names the project it diagnosed.
    expect(doctor(legacyProject, tmpdir()).replace(/\s+/g, " ")).toContain(`--project-dir ${legacyProject}\``);
    expect(doctor(install("kiro-ide").project)).not.toContain("now sets new projects up");
    // The shown row counts as passed in the human report, as --quiet counts it.
    const quiet = spawnSync(process.execPath, [DOCTOR, "--project-dir", legacyProject, "--quiet"], {
      cwd: legacyProject,
      env: childEnv(),
      encoding: "utf-8",
    });
    const quietPassed = /(\d+) passed/.exec(`${quiet.stdout ?? ""}${quiet.stderr ?? ""}`)?.[1];
    const humanPassed = [...legacy.matchAll(/ok {4}(?:all )?(\d+) checks passed/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(quietPassed, quiet.stdout).toBeDefined();
    expect(humanPassed).toBe(Number(quietPassed));
  });

  test("doctor tells a project with another harness beside its legacy .kiro too", () => {
    const { project } = install("kiro");
    const claude = spawnSync(
      process.execPath,
      [INIT, "config", "--from", join(RELEASE, "claude"), "--harness", "claude", "--mcp", "none", "--yes"],
      { cwd: project, env: childEnv(), encoding: "utf-8" },
    );
    expect(claude.status, `${claude.stdout ?? ""}${claude.stderr ?? ""}`).toBe(0);
    const result = spawnSync(process.execPath, [DOCTOR, "--project-dir", project], {
      cwd: project,
      env: childEnv({ AIDLC_HARNESS_DIR: ".claude" }),
      encoding: "utf-8",
    });
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("this project is on the legacy `kiro-cli-legacy` row");
  });

  // The Kiro CLI guide's way through for a project whose agents Kiro CLI 3.0
  // already upgraded (it keeps each original as a .json.bak): the switch names
  // the changed agent files, moving them aside lets it go on, and the .json.bak
  // files stay. A hand edit stands in for Kiro's rewrite.
  test("a switch stops on agent files Kiro rewrote, and goes on once they are moved aside", () => {
    const { project } = install("kiro");
    const agent = join(project, ".kiro", "agents", "aidlc.json");
    writeFileSync(`${agent}.bak`, readFileSync(agent));
    writeFileSync(agent, JSON.stringify({ ...JSON.parse(readFileSync(agent, "utf-8")), upgraded: true }));
    const switchArgs = [INIT, "config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none", "--yes"];
    const stopped = spawnSync(process.execPath, switchArgs, { cwd: project, env: childEnv(), encoding: "utf-8" });
    const said = `${stopped.stdout ?? ""}${stopped.stderr ?? ""}`;
    expect(stopped.status, said).not.toBe(0);
    expect(said).toContain(".kiro/agents/aidlc.json (removed upstream but locally modified)");
    expect(said).toContain("to keep your version, move");
    expect(said).toContain("run it again with --force");

    const aside = join(realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-aside-"))), "aidlc.json");
    temporary.push(join(aside, ".."));
    renameSync(agent, aside);
    const moved = spawnSync(process.execPath, switchArgs, { cwd: project, env: childEnv(), encoding: "utf-8" });
    expect(moved.status, `${moved.stdout ?? ""}${moved.stderr ?? ""}`).toBe(0);
    expect(moved.stdout).toContain("switched .kiro in place from kiro to kiro-ide (aidlc/ kept)");
    expect(existsSync(join(project, ".kiro", "agents", "aidlc-aidlc.md"))).toBe(true);
    expect(existsSync(`${agent}.bak`)).toBe(true);
  });

  // The names a person types: `kiro` is the Kiro row (id kiro-ide),
  // `kiro-cli-legacy` the legacy row (id kiro); the retired `kiro-ide` says
  // what to type instead and writes nothing.
  test("--harness kiro sets up the Kiro row and says the versions it runs in; kiro-ide says to type kiro", () => {
    const fresh = (): string => {
      const project = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-")));
      temporary.push(project);
      mkdirSync(join(project, ".git"));
      return project;
    };
    const config = (project: string, args: string[]) => {
      const result = spawnSync(process.execPath, [INIT, "config", "--from", join(RELEASE, "kiro-ide"), ...args], {
        cwd: project,
        env: childEnv(),
        encoding: "utf-8",
      });
      return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    };
    const kiro = fresh();
    const set = config(kiro, ["--harness", "kiro", "--mcp", "none", "--yes"]);
    expect(set.status, set.out).toBe(0);
    expect(set.out).toContain(
      "Note: AI-DLC's Kiro row runs in Kiro IDE 1.1.70 or later and in Kiro CLI 2.24.1 or later; older versions are not supported.",
    );
    expect(existsSync(join(kiro, ".kiro", "agents", "aidlc-aidlc.md"))).toBe(true);

    const retired = fresh();
    const named = config(retired, ["--harness", "kiro-ide", "--mcp", "none", "--yes"]);
    expect(named.status).not.toBe(0);
    expect(named.out).toContain("`kiro-ide` is now called `kiro`");
    // The same line, with the name to type.
    expect(named.out).toContain(" --harness kiro --mcp none --yes\n");
    expect(existsSync(join(retired, ".kiro"))).toBe(false);
  });

  // At a terminal, `--harness kiro` on a project still on the legacy row asks
  // before it moves it (the name meant the legacy row before); "n" writes
  // nothing, and --yes moves it.
  test("--harness kiro on a legacy project asks at a terminal before it moves it", () => {
    const { project } = install("kiro");
    const args = [INIT, "config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none"];
    const asked = spawnSync(process.execPath, args, {
      cwd: project,
      env: childEnv({ AIDLC_TEST_CONFIG_TTY: "1" }),
      input: "n\n",
      encoding: "utf-8",
    });
    const said = `${asked.stdout ?? ""}${asked.stderr ?? ""}`;
    expect(said.replace(/\s+/g, " ")).toContain(
      "This project is on the legacy `kiro-cli-legacy` row, and `--harness kiro` now names the Kiro row. Move .kiro to it in place (aidlc/ is kept)?",
    );
    expect(said).toContain("Nothing written.");
    expect(existsSync(join(project, ".kiro", "agents", "aidlc.json"))).toBe(true);

    const moved = spawnSync(process.execPath, [...args, "--yes"], { cwd: project, env: childEnv(), encoding: "utf-8" });
    expect(moved.status, `${moved.stdout ?? ""}${moved.stderr ?? ""}`).toBe(0);
    expect(moved.stdout).toContain("switched .kiro in place from kiro to kiro-ide (aidlc/ kept)");
  });

  // With this machine's Kiro CLI older than the Kiro row needs, a person at a
  // terminal is asked first; --yes says so and goes on.
  test.skipIf(process.platform === "win32")("--harness kiro with an older Kiro CLI asks first at a terminal, and --yes says so", () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-bin-")));
    temporary.push(bin);
    writeFileSync(join(bin, "kiro-cli"), "#!/bin/sh\necho 'kiro-cli 2.20.0'\n");
    chmodSync(join(bin, "kiro-cli"), 0o755);
    const env = (extra: Record<string, string> = {}) => childEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, ...extra });
    const older =
      "Kiro CLI 2.20.0 is older than 2.24.1. AI-DLC's Kiro row works in Kiro CLI 2.24.1 or later (and in Kiro IDE 1.1.70 or later).";
    const project = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-")));
    temporary.push(project);
    mkdirSync(join(project, ".git"));
    const args = [INIT, "config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none"];
    const asked = spawnSync(process.execPath, args, {
      cwd: project,
      env: env({ AIDLC_TEST_CONFIG_TTY: "1" }),
      input: "n\n",
      encoding: "utf-8",
    });
    const said = `${asked.stdout ?? ""}${asked.stderr ?? ""}`;
    expect(said.replace(/\s+/g, " ")).toContain(`${older} Set up anyway? [y/N]:`);
    expect(said).toContain("Nothing written.");
    expect(existsSync(join(project, ".kiro"))).toBe(false);

    const went = spawnSync(process.execPath, [...args, "--yes"], { cwd: project, env: env(), encoding: "utf-8" });
    const out = `${went.stdout ?? ""}${went.stderr ?? ""}`;
    expect(went.status, out).toBe(0);
    expect(out).toContain(`Note: ${older}`);
    expect(existsSync(join(project, ".kiro", "agents", "aidlc-aidlc.md"))).toBe(true);
  });

  // Typed names become row ids once, at the outermost entry, and go back to
  // typed names wherever a command is printed.
  test("a config line reads typed names as row ids once, and prints them back as typed names", () => {
    expect(harnessArgsAsIds(["models", "--harness", "kiro", "--project"])).toEqual({
      args: ["models", "--harness", "kiro-ide", "--project"],
      typed: "kiro",
    });
    expect(harnessArgsAsIds(["--harness", "kiro-cli-legacy"]).args).toEqual(["--harness", "kiro"]);
    expect(harnessArgsAsIds(["--harness", "kiro-ide", "--yes"]).retired).toEqual({
      typed: "kiro-ide",
      instead: "kiro",
      args: ["--harness", "kiro", "--yes"],
    });
    expect(harnessArgsAsTyped(["--harness", "kiro-ide", "--harness", "kiro"])).toEqual(
      ["--harness", "kiro", "--harness", "kiro-cli-legacy"],
    );

    // Through the dispatcher, and the commands config prints back.
    const { project } = install("kiro-ide");
    const dispatch = (args: string[]) => {
      const result = spawnSync(process.execPath, [DISPATCHER, "config", "--project-dir", project, ...args], {
        cwd: project,
        env: childEnv(),
        encoding: "utf-8",
      });
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    };
    expect(dispatch(["--harness", "kiro-ide", "--mcp", "none"])).toContain(
      `config --project-dir ${project} --harness kiro --mcp none`,
    );
    const rerun = dispatch(["models", "--harness", "kiro", "--agent", "developer", "--model", "claude-x", "--project"]);
    expect(rerun).toContain("config models --harness kiro --agent developer --model claude-x --project");
    expect(rerun).toMatch(/ --yes\n/);
    expect(rerun).not.toContain("kiro-ide");
    const undo = dispatch(["models", "--harness", "kiro", "--agent", "developer", "--model", "claude-x", "--project", "--yes"]);
    expect(undo).toContain("developer model (kiro) claude-x");
    expect(undo).toMatch(/To undo: [^\n]* config models --agent developer --model default --harness kiro --project --yes/);
  });

  // A run that moves a legacy project because `--harness kiro` now names the
  // Kiro row says so when nobody was asked, and a preview never asks.
  test.skipIf(process.platform === "win32")("an unasked move says why, a preview never asks, and a terminal is asked once", () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-bin-")));
    temporary.push(bin);
    writeFileSync(join(bin, "kiro-cli"), "#!/bin/sh\necho 'kiro-cli 2.20.0'\n");
    chmodSync(join(bin, "kiro-cli"), 0o755);
    const env = (extra: Record<string, string> = {}) => childEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, ...extra });
    const args = [INIT, "config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro", "--mcp", "none"];

    const preview = install("kiro").project;
    const previewed = spawnSync(process.execPath, [...args, "--dry-run"], {
      cwd: preview,
      env: env({ AIDLC_TEST_CONFIG_TTY: "1" }),
      input: "",
      encoding: "utf-8",
    });
    expect(previewed.status, `${previewed.stdout ?? ""}${previewed.stderr ?? ""}`).toBe(0);
    expect(previewed.stdout).not.toContain("[y/N]");
    expect(previewed.stdout).toContain("config plan for");

    const asked = spawnSync(process.execPath, args, {
      cwd: preview,
      env: env({ AIDLC_TEST_CONFIG_TTY: "1" }),
      input: "n\n",
      encoding: "utf-8",
    });
    const said = `${asked.stdout ?? ""}${asked.stderr ?? ""}`;
    expect(said.match(/\[y\/N\]/g)?.length).toBe(1);
    expect(said.replace(/\s+/g, " ")).toContain("Kiro CLI 2.20.0 is older than 2.24.1.");
    expect(said).toContain("Move .kiro to it in place");

    const moved = spawnSync(process.execPath, [...args, "--yes"], { cwd: preview, env: env(), encoding: "utf-8" });
    expect(moved.status, `${moved.stdout ?? ""}${moved.stderr ?? ""}`).toBe(0);
    expect(moved.stdout.replace(/\s+/g, " ")).toContain(
      "Note: `--harness kiro` now names the Kiro row, so this run moves .kiro off the legacy `kiro-cli-legacy` row; `--harness kiro-cli-legacy` keeps a project on that row.",
    );
  });
});
