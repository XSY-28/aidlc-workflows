// covers: function:retiredRowLine, function:rowNewProjectsGet, function:retiredRowDoctorCheck, tool:aidlc-doctor
//
// New projects are no longer offered the legacy Kiro CLI row (`kiro`, agent-v1);
// the kiro-ide row serves Kiro CLI on its 3.0 engine and Kiro IDE. A project
// that has the legacy row keeps it: config and doctor say how to move it
// whenever they run. A project on any other row hears nothing of it. (The
// first-run picker is t299.)
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { retiredRowLine, rowNewProjectsGet } from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(120_000);

const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DOCTOR = join(REPO_ROOT, "core", "tools", "aidlc-doctor.ts");
const RELEASE = join(REPO_ROOT, "dist-release");
const HOST_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "KIRO_SESSION_ID", "OPENCODE",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "AIDLC_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_COMPILED_EXECUTABLE", "AIDLC_TEST_CONFIG_DETECTION_JSON",
];
const STANDS = "AI-DLC now sets new projects up on the `kiro-ide` row; this project is on the legacy `kiro` row, which keeps working.";
const MOVE = "To move it to `kiro-ide`, which runs in Kiro IDE and in Kiro CLI 2.24.1 or later on its v3 engine, run `aidlc config --harness kiro-ide`.";

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
    [INIT, "config", "--from", join(RELEASE, harness), "--harness", harness, "--mcp", "none", "--yes"],
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
      "run `bun .kiro/tools/aidlc.ts config --harness kiro-ide --project-dir /p`.",
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
    expect(configIn(runtimeOf(["kiro", "kiro-ide"]))).toContain("multiple harnesses are installed; pass --harness <kiro-ide>");
    expect(configIn(runtimeOf(["claude", "kiro"]))).toContain("multiple harnesses are installed; pass --harness <claude|kiro>");
  });

  test("config on a legacy project says how to move it; on kiro-ide it says nothing of it", () => {
    const legacy = install("kiro");
    expect(legacy.out).toContain(`Note: ${STANDS} To move it to \`kiro-ide\``);
    expect(existsSync(join(legacy.project, ".kiro", "agents", "aidlc.json"))).toBe(true);
    // A refresh of the installed row says it again; the row stays.
    const refresh = spawnSync(process.execPath, [INIT, "config", "--from", join(RELEASE, "kiro"), "--yes"], {
      cwd: legacy.project,
      env: childEnv(),
      encoding: "utf-8",
    });
    const refreshed = `${refresh.stdout ?? ""}${refresh.stderr ?? ""}`;
    expect(refresh.status, refreshed).toBe(0);
    expect(refreshed).toContain(`Note: ${STANDS}`);
    expect(existsSync(join(legacy.project, ".kiro", "agents", "aidlc.json"))).toBe(true);

    expect(install("kiro-ide").out).not.toContain("now sets new projects up");

    // A preview of a new install has no project on the row yet.
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-legacy-kiro-")));
    temporary.push(fresh);
    mkdirSync(join(fresh, ".git"));
    const preview = spawnSync(
      process.execPath,
      [INIT, "config", "--from", join(RELEASE, "kiro"), "--harness", "kiro", "--mcp", "none", "--dry-run"],
      { cwd: fresh, env: childEnv(), encoding: "utf-8" },
    );
    expect(preview.status, `${preview.stdout ?? ""}${preview.stderr ?? ""}`).toBe(0);
    expect(`${preview.stdout ?? ""}${preview.stderr ?? ""}`).not.toContain("this project is on the legacy");
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
      /\n {2}ok {4}AI-DLC now sets new projects up on the `kiro-ide` row; this project is on the legacy `kiro` row, which keeps working\. To move it to `kiro-ide`, which runs in Kiro IDE and in Kiro CLI 2\.24\.1 or later on its v3 engine, run `[^`\n]* config --harness kiro-ide`\.\n/,
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
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("this project is on the legacy `kiro` row");
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
    const switchArgs = [INIT, "config", "--from", join(RELEASE, "kiro-ide"), "--harness", "kiro-ide", "--mcp", "none", "--yes"];
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
});
