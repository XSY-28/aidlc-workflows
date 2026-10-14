// covers: function:retiredRowLine, function:rowNewProjectsGet, function:retiredRowDoctorCheck, tool:aidlc-doctor, hook:aidlc-session-start
//
// New projects are no longer offered the legacy Kiro CLI row (`kiro`, agent-v1);
// the kiro-ide row serves Kiro CLI on its 3.0 engine and Kiro IDE. A project
// that has the legacy row keeps it: config and doctor say how to move it
// whenever they run, and the first chat in each clone says it once. A project
// on any other row hears nothing of it. (The first-run picker is t299.)
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
const STANDS = "New projects no longer get AI-DLC's `kiro` row, and this project keeps working on it.";
const MOVE = "To move it to the `kiro-ide` row, which runs on Kiro CLI 3.0 and Kiro IDE, run `aidlc config --harness kiro-ide`.";

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

// The project's own session-start hook, as Kiro starts it for a new chat.
function sessionStart(project: string, sessionId: string): string {
  const result = spawnSync(process.execPath, [join(project, ".kiro", "hooks", "aidlc-session-start.ts")], {
    cwd: project,
    env: childEnv({ AIDLC_PROJECT_DIR: project }),
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf-8",
  });
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
    expect(legacy.out).toContain(`Note: ${STANDS} To move it to the \`kiro-ide\` row`);
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

    expect(install("kiro-ide").out).not.toContain("New projects no longer get");
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
      /\n +fix: To move it to the `kiro-ide` row, which runs on Kiro CLI 3\.0 and Kiro IDE, run `[^`\n]* config --harness kiro-ide`\.\n/,
    );
    expect(doctor(install("kiro-ide").project)).not.toContain("New projects no longer get");
  });

  test("the first chat in a clone says it once; later chats and kiro-ide projects do not", () => {
    const legacy = install("kiro");
    const first = sessionStart(legacy.project, "sess-legacy-one");
    expect(first).toContain(`TELL ONCE: in your first reply, tell the person this, in their language: \\"${STANDS} ${MOVE}\\"`);
    expect(sessionStart(legacy.project, "sess-legacy-two")).not.toContain("New projects no longer get");

    const current = install("kiro-ide");
    expect(sessionStart(current.project, "sess-current-one")).not.toContain("New projects no longer get");
  });
});
