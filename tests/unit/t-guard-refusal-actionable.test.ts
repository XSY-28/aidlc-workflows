// covers: hook:aidlc-plan-approval-guard, hook:aidlc-review-freeze, hook:aidlc-reviewer-scope, subcommand:aidlc-state(lifecycle-owner-guard), function:unattendedHumanPresenceHint
//
// t-guard-refusal-actionable (#1593): one contract every formal guard refusal
// keeps, checked on a real refusal from each guard. A refusal
//   1. leaves nothing for the agent to fill in but the person's own words, a
//      review verdict, or a scope the prose names (the fill-in slots);
//   2. names a way on: a command written out in full, a permitted operation,
//      or a human action;
//   3. names any engine command in the form this install runs, by a route the
//      engine has;
//   4. never cites the refusal bookkeeping (.aidlc-engine/guard-refusals/) as
//      the record that lets the call through.
// Each case drives the shipped tree as the agent would meet the refusal.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  approvalFingerprint,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { stateDigest, workspaceSourceFingerprint, writeActiveDirectiveMarker } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DIST = join(REPO_ROOT, "dist", "claude", ".claude");
const BUN = process.execPath;
const STATE = join(DIST, "tools", "aidlc-state.ts");
const LOG = join(DIST, "tools", "aidlc-log.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) cleanupTestProject(dir);
});

// The slots a refusal may leave: the person's reply, a reviewer's verdict, and
// a scope the same refusal names in prose.
const FILL_IN_SLOTS = ["<their words>", "<READY|NOT-READY>", "<scope>"];
const PERMITTED_OPERATION = /\b(?:use the files|keep (?:searches|reads)|make that change|write (?:it|them) )|\bend (?:the|your) turn\b|\bask (?:the person|them)\b|\bwait for\b/i;

interface ContractBreak {
  rule: string;
  detail: string;
}

function refusalText(said: string): string {
  const trimmed = said.trim();
  try {
    return String((JSON.parse(trimmed) as { error?: unknown }).error ?? trimmed);
  } catch {
    return trimmed;
  }
}

function contractBreaks(said: string): ContractBreak[] {
  const text = refusalText(said);
  const breaks: ContractBreak[] = [];
  let open = text;
  for (const slot of FILL_IN_SLOTS) open = open.replaceAll(slot, "");
  for (const slot of open.match(/<[^<>\s][^<>]*>/g) ?? []) breaks.push({ rule: "1 nothing left to fill in", detail: slot });
  const commands = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (commands.length === 0 && !PERMITTED_OPERATION.test(text)) {
    breaks.push({ rule: "2 names a way on", detail: "no command written out, permitted operation, or human action" });
  }
  for (const command of commands) {
    const source = command.match(/^bun \.claude\/tools\/(aidlc(?:-[a-z-]+)?\.ts)(?:\s|$)/);
    const native = command.match(/^aidlc(?:\.exe)? engine ([a-z-]+)\b/);
    if (source && !existsSync(join(DIST, "tools", source[1]))) {
      breaks.push({ rule: "3 an engine command this install runs", detail: command });
    }
    if (!source && !native && /\baidlc[-a-z]*\.ts\b|\baidlc engine\b/.test(command)) {
      breaks.push({ rule: "3 an engine command this install runs", detail: command });
    }
  }
  if (text.includes("guard-refusals")) breaks.push({ rule: "4 bookkeeping is not evidence", detail: "cites guard-refusals" });
  return breaks;
}

// --- one real refusal per guard ------------------------------------------------

function stateToolRefusal(): string {
  const project = createTestProject();
  dirs.push(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project };
  delete env.AIDLC_STATE_TRANSITION_OWNER;
  delete env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS;
  const r = spawnSync(BUN, [STATE, "approve", "feasibility", "--project-dir", project], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
  return `${r.stdout}${r.stderr}`;
}

function humanPresenceRefusal(): string {
  const project = createTestProject();
  dirs.push(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Only the presence check is under test; the bare fixture has no stage questions.
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  delete env.VSCODE_IPC_HOOK;
  delete env.VSCODE_PID;
  delete env.TERM_PROGRAM;
  const run = (args: string[]) =>
    spawnSync(BUN, [STATE, ...args, "--project-dir", project], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env,
    });
  run(["checkbox", "feasibility=in-progress"]);
  run(["gate-start", "feasibility"]);
  const r = run(["approve", "feasibility", "--user-input", "Approve"]);
  expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0);
  expect(`${r.stdout}${r.stderr}`).toContain("Cannot approve");
  return `${r.stdout}${r.stderr}`;
}

function reviewFreezeRefusal(): string {
  const project = createTestProject();
  dirs.push(project);
  seedAidlcMemory(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-inception.md"));
  const dir = join(seededRecordDir(project), "inception", "requirements-analysis");
  mkdirSync(dir, { recursive: true });
  const artifact = join(dir, "requirements.md");
  writeFileSync(artifact, "# Requirements\n");
  writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Requirements Questions\n");
  const env = { ...process.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" };
  const args = [
    LOG, "review", "--stage", "requirements-analysis", "--reviewer", "aidlc-product-lead-agent",
    "--iteration", "1", "--project-dir", project,
  ];
  const requested = spawnSync(BUN, args, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  expect(requested.status, `${requested.stdout}${requested.stderr}`).toBe(0);
  const { reviewFile } = JSON.parse(requested.stdout) as { reviewFile: string };
  mkdirSync(dirname(join(project, reviewFile)), { recursive: true });
  writeFileSync(
    join(project, reviewFile),
    "**Verdict:** READY\n**Reviewer:** aidlc-product-lead-agent\n**Iteration:** 1\n\n### Findings\n\nFixture review.\n",
  );
  const done = spawnSync(BUN, [...args, "--verdict", "READY"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  expect(done.status, `${done.stdout}${done.stderr}`).toBe(0);
  const r = spawnSync(BUN, [join(DIST, "hooks", "aidlc-review-freeze.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: artifact } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    encoding: "utf-8",
  });
  expect(r.status, r.stderr).toBe(2);
  return r.stderr ?? "";
}

function hookProject(prefix: string): string {
  const project = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(project);
  mkdirSync(join(project, ".claude"), { recursive: true });
  cpSync(join(DIST, "hooks"), join(project, ".claude", "hooks"), { recursive: true });
  cpSync(join(DIST, "tools"), join(project, ".claude", "tools"), { recursive: true });
  return project;
}

function reviewerScopeRefusal(): string {
  const project = hookProject("t-guard-refusal-scope-");
  const engine = join(project, "aidlc", "spaces", "default", "intents", ".aidlc-engine");
  mkdirSync(engine, { recursive: true });
  writeFileSync(
    join(engine, "reviewer-dispatch.json"),
    JSON.stringify({ reviewer: "aidlc-architecture-reviewer-agent", stage: "nfr-requirements", unit: "U03-scoring", exempt: [] }),
  );
  const r = spawnSync(BUN, [join(project, ".claude", "hooks", "aidlc-reviewer-scope.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "grep -rn x construction/*/*/*.md" },
      agent_type: "aidlc-architecture-reviewer-agent",
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    encoding: "utf-8",
  });
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toContain("This review cannot open");
  return r.stderr ?? "";
}

function planApprovalRefusal(): string {
  const project = hookProject("t-guard-refusal-plan-");
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  const record = join(intents, "t-guard-refusal");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(intents, "active-intent"), "t-guard-refusal\n");
  for (const args of [
    ["init", "-q"], ["config", "user.email", "tests@example.com"], ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"], ["commit", "-qm", "baseline"],
  ]) {
    spawnSync("git", args, { cwd: project, encoding: "utf-8" });
  }
  const statePath = join(record, "aidlc-state.md");
  writeFileSync(
    statePath,
    "# AI-DLC State Tracking\n\n## Project Information\n- **Project**: fixture\n- **Scope**: poc\n\n" +
      "## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n- **Current Stage**: code-generation\n",
  );
  const stage = join(record, "construction", "code-generation");
  mkdirSync(stage, { recursive: true });
  writeActiveDirectiveMarker(project, { kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(readFileSync(statePath, "utf-8")) });
  const authority = resolveCodeGenerationAuthority(project, { unit: null });
  const contract = resolveTestingPosture(project);
  const plan = `# Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Step 1\n`;
  const instructions = "# Unit Test Instructions\n\n## Command\n\n`bun test x.test.ts`\n";
  writeFileSync(join(stage, "code-generation-plan.md"), plan);
  writeFileSync(join(stage, "unit-test-instructions.md"), instructions);
  writeFileSync(
    join(stage, "code-generation-questions.md"),
    `## Plan Approval\n[Approval Fingerprint]: ${approvalFingerprint(plan, instructions, contract.contract_sha256, authority)}\n` +
      `[Planned Source]: ${workspaceSourceFingerprint(project) ?? "unbindable"}\n[Answer]:\n`,
  );
  // A shell form the guard cannot see through is refused while the plan waits.
  const r = spawnSync(BUN, [join(project, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat $(ls src)" } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    encoding: "utf-8",
  });
  expect(r.status, r.stderr).toBe(2);
  return r.stderr ?? "";
}

describe("t-guard-refusal-actionable (#1593) every formal guard refusal keeps one contract", () => {
  const cases: Array<[string, () => string]> = [
    ["plan approval: a call while the plan waits for approval", planApprovalRefusal],
    ["review freeze: a write to a document whose review is final", reviewFreezeRefusal],
    ["state transition: a lifecycle verb run directly through the state tool", stateToolRefusal],
    ["reviewer scope: a reviewer reading another Unit", reviewerScopeRefusal],
    ["human presence: an approval with no reply from the person", humanPresenceRefusal],
  ];
  for (const [name, refuse] of cases) {
    test(name, () => {
      const said = refuse();
      expect(contractBreaks(said), refusalText(said)).toEqual([]);
    });
  }

  test("the contract itself: a filled-in step passes, a placeholder or a bookkeeping citation does not", () => {
    expect(contractBreaks("Run `bun .claude/tools/aidlc-orchestrate.ts next` on its own.")).toEqual([]);
    expect(contractBreaks("Run `bun .claude/tools/aidlc.ts engine orchestrate next`.")).toEqual([]);
    expect(contractBreaks("Run `aidlc engine orchestrate next`.")).toEqual([]);
    expect(contractBreaks("Run `bun .claude/tools/aidlc-utility.ts config-change --person-words '<their words>'`.")).toEqual([]);
    expect(contractBreaks("Use `report --stage <slug>`.").map((b) => b.rule)).toContain("1 nothing left to fill in");
    expect(contractBreaks("It is refused.").map((b) => b.rule)).toContain("2 names a way on");
    expect(contractBreaks("Run `bun .claude/tools/aidlc-nope.ts next`.").map((b) => b.rule)).toContain("3 an engine command this install runs");
    expect(contractBreaks("See .aidlc-engine/guard-refusals/x.json; use the files you were given.").map((b) => b.rule))
      .toContain("4 bookkeeping is not evidence");
  });
});

