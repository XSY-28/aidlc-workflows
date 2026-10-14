// covers: function:retiredRowLine, function:rowNewProjectsGet, function:retiredRowDoctorCheck, tool:aidlc-doctor, hook:aidlc-session-start
//
// New projects are no longer offered the legacy Kiro CLI row (`kiro`, agent-v1);
// the kiro-ide row serves Kiro CLI on its 3.0 engine and Kiro IDE. A project
// that has the legacy row keeps it: config and doctor say how to move it
// whenever they run, and the first chat in each clone says it once. A project
// on any other row hears nothing of it. (The first-run picker is t299.)
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
const MOVE = "To move it to `kiro-ide`, which runs in Kiro IDE and in Kiro CLI on its v3 engine, run `aidlc config --harness kiro-ide`.";

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

// A new chat's start, as Kiro starts it: on the legacy row through its adapter,
// with the agentSpawn payload Kiro CLI sends (no session id; captured on
// 2.6.1, tests/fixtures/kiro-hook-payloads/payloads.json); on kiro-ide the
// core hook with a session id.
function chatStart(project: string, harness: "kiro" | "kiro-ide", sessionId: string): string {
  const legacy = harness === "kiro";
  const result = spawnSync(
    process.execPath,
    legacy
      ? [join(project, ".kiro", "tools", "aidlc.ts"), "engine", "adapter", "kiro", "session-start"]
      : [join(project, ".kiro", "hooks", "aidlc-session-start.ts")],
    {
      cwd: project,
      env: childEnv(legacy ? {} : { AIDLC_PROJECT_DIR: project }),
      input: JSON.stringify(
        legacy
          ? { hook_event_name: "agentSpawn", cwd: project, prompt: "hello" }
          : { session_id: sessionId, hook_event_name: "SessionStart", source: "startup" },
      ),
      encoding: "utf-8",
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

describe("the legacy kiro row new projects no longer get", () => {
  test("one rule names it, the row new projects get instead, and the line that moves a project", () => {
    expect(rowNewProjectsGet("kiro")).toBe("kiro-ide");
    for (const row of ["kiro-ide", "claude", "codex", "copilot", "cursor", "opencode"]) {
      expect(rowNewProjectsGet(row)).toBeNull();
      expect(retiredRowLine(row, (args) => `aidlc config ${args}`)).toBeNull();
    }
    expect(retiredRowLine("kiro", (args) => `aidlc config ${args}`)).toBe(`${STANDS} ${MOVE}`);
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
  });

  test("doctor warns on a legacy project with the step as its fix, and says nothing of it elsewhere", () => {
    const doctor = (project: string): string => {
      const result = spawnSync(process.execPath, [DOCTOR, "--project-dir", project], {
        cwd: project,
        env: childEnv(),
        encoding: "utf-8",
      });
      if (result.error) throw result.error;
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    };
    const legacy = doctor(install("kiro").project);
    expect(legacy).toContain(`warn  ${STANDS}\n`);
    expect(legacy).toMatch(
      /\n +fix: To move it to `kiro-ide`, which runs in Kiro IDE and in Kiro CLI on its v3 engine, run `[^`\n]* config --harness kiro-ide`\.\n/,
    );
    expect(doctor(install("kiro-ide").project)).not.toContain("now sets new projects up");
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

  test("the first chat in a clone says it once, with no session id; later chats and kiro-ide projects do not", () => {
    const legacy = install("kiro");
    const first = chatStart(legacy.project, "kiro", "");
    // Kiro's agentSpawn context is the adapter's plain text.
    expect(first).toContain(`TELL ONCE: in your first reply, tell the person this, in their language: "${STANDS} ${MOVE}"`);
    expect(chatStart(legacy.project, "kiro", "")).not.toContain("now sets new projects up");

    const current = install("kiro-ide");
    expect(chatStart(current.project, "kiro-ide", "sess-current-one")).not.toContain("now sets new projects up");
  });
});
