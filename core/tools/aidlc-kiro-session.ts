// Kiro CLI session model, kept in the person's PERSONAL Kiro settings.
//
// Kiro CLI runs every AI-DLC session on one model. It lives in the person's
// own Kiro settings (the file Kiro's `/model set-current-as-default` writes),
// never in the committed project file: model lists differ per Kiro account,
// and a project model a teammate's account lacks fails every prompt they send.
// A project `chat.modelDefaults` would also replace the person's whole
// personal map inside the project, so AI-DLC writes none there. Kiro IDE does
// not read it: it has its own model picker.
//
// Everything goes through Kiro's own CLI, so KIRO_HOME (unless a project's .env
// sets it, see kiroEnv) and Kiro's file format are Kiro's concern:
//   - models:  `kiro-cli chat --list-models --format json`
//   - current: `kiro-cli settings list --format json`, run in an empty folder so
//              no project file joins in
//   - write:   `kiro-cli settings chat.defaultModel <id>`, leaving the person's
//              other settings alone
//
// AIDLC_TEST_KIRO_SESSION_JSON replaces every Kiro call in tests (see
// kiroSessionTestSeam). When the config detection seam is set without it, Kiro is
// treated as unavailable, so a test never reaches a real kiro-cli or ~/.kiro.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { resolveExecutableOnPath } from "./aidlc-config-diagnostics.ts";
import { setByDotenvFile } from "./aidlc-runtime-paths.ts";
import type { KiroEffort } from "./aidlc-tiers.ts";

export type KiroModelTag = "preview" | "internal";
export type KiroModel = { id: string; rate: number | null; tag: KiroModelTag | null };

export type KiroModelList =
  | { ok: true; models: KiroModel[] }
  | { ok: false; reason: string };

export type KiroPersonalSession =
  | {
    ok: true;
    // null is Kiro auto: no personal model, so Kiro picks one per task.
    model: string | null;
    modelDefaults: Record<string, unknown>;
  }
  | { ok: false; reason: string };

export type KiroSessionWrite = { model?: string; effort?: { model: string; effort: KiroEffort } };

export const KIRO_EFFORT_ORDER: readonly KiroEffort[] = ["low", "medium", "high", "xhigh", "max"];

const LIST_TIMEOUT_MS = 30_000;
const SETTINGS_TIMEOUT_MS = 30_000;

type KiroSessionSeam = {
  models?: Array<{ model_id: string; description?: string; rate_multiplier?: number }> | null;
  current?: Record<string, unknown> | null;
  writes?: string;
  // The settings key whose write fails, to test a write Kiro rejects.
  failWrite?: string;
};

// The seam only appends to a file named writes.jsonl, as every test names its
// log, so a project .env that sets the seam cannot append to the person's files.
function isSeamWriteLog(path: string): boolean {
  return basename(path) === "writes.jsonl";
}

// Bun loads the .env files of the folder it runs in, so a seam those files set
// is ignored: only a variable the test runner set reaches the seam, never one a
// project ships to forge Kiro's answers. aidlc-runtime-paths.ts drops such names from
// process.env before any read; these checks stay as a second, per-name answer.
export { setByDotenvFile };

// The environment Kiro runs with. A KIRO_HOME that a project's .env sets is
// dropped, so Kiro reads and writes the person's own settings, never a folder a
// repository chose.
export function kiroEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!setByDotenvFile("KIRO_HOME")) return env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "KIRO_HOME"));
}

function kiroSessionTestSeam(env: NodeJS.ProcessEnv = process.env): KiroSessionSeam | null {
  const raw = env.AIDLC_TEST_KIRO_SESSION_JSON;
  if (raw === undefined || setByDotenvFile("AIDLC_TEST_KIRO_SESSION_JSON")) return null;
  return JSON.parse(raw) as KiroSessionSeam;
}

export function isKiroEffort(value: unknown): value is KiroEffort {
  return typeof value === "string" && (KIRO_EFFORT_ORDER as readonly string[]).includes(value);
}

// The kiro-cli this process would run, or null when there is none. Under the
// test runner (AIDLC_TEST_NAME) or a stubbed config detection, the host's
// kiro-cli is never used: a test opts in with the data seam or names a fake
// kiro-cli to the functions directly, so no test reaches a real ~/.kiro. No
// variable names the program to run: Bun loads a project's .env, so one could
// otherwise make AI-DLC run a program the project ships.
export function kiroCliPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (kiroSessionTestSeam(env)) return "kiro-cli";
  if (env.AIDLC_TEST_NAME !== undefined || env.AIDLC_TEST_CONFIG_DETECTION_JSON !== undefined) {
    return null;
  }
  // Only absolute PATH entries: a relative one (such as ".") resolves inside the
  // project, where a repository could ship its own kiro-cli.
  const absolute = (env.PATH ?? env.Path ?? "").split(delimiter).filter((entry) => isAbsolute(entry));
  return resolveExecutableOnPath("kiro-cli", absolute.join(delimiter));
}

// Where Kiro keeps personal settings, for display only (Kiro owns the file).
export function kiroPersonalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = join(kiroEnv(env).KIRO_HOME || join(homedir(), ".kiro"), "settings", "cli.json");
  const home = homedir();
  return process.platform !== "win32" && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

export function kiroModelTag(description: string | undefined): KiroModelTag | null {
  const text = (description ?? "").trim();
  if (/^\[internal\]/i.test(text)) return "internal";
  if (/^experimental preview\b/i.test(text)) return "preview";
  return null;
}

export function kiroRateLabel(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "";
  return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}x`;
}

// Model ids AI-DLC prints and passes to kiro-cli: anything else Kiro reports is
// left out, so its words never reach a line AI-DLC prints.
export function isPlainKiroId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value);
}

export function parseKiroModelList(raw: string): KiroModelList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Kiro's model list was not readable" };
  }
  const rows = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return { ok: false, reason: "Kiro's model list was not readable" };
  const models: KiroModel[] = [];
  for (const row of rows) {
    const id = (row as { model_id?: unknown })?.model_id;
    // A model id is printed and passed to kiro-cli, so only a plain one is kept.
    if (typeof id !== "string" || id === "auto" || !isPlainKiroId(id)) continue;
    const rate = (row as { rate_multiplier?: unknown }).rate_multiplier;
    models.push({
      id,
      rate: typeof rate === "number" ? rate : null,
      tag: kiroModelTag((row as { description?: string }).description),
    });
  }
  return models.length > 0
    ? { ok: true, models }
    : { ok: false, reason: "Kiro listed no models for this account" };
}

// An empty folder to run kiro-cli in. Removal retries and never throws: on
// Windows a Kiro process that is still shutting down can hold its working
// folder for a moment, and a leftover empty temp folder harms nothing.
function removeFolder(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Left in the temp directory.
  }
}

function withEmptyFolder<T>(run: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), "aidlc-kiro-"));
  try {
    return run(folder);
  } finally {
    removeFolder(folder);
  }
}

export function listKiroModels(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LIST_TIMEOUT_MS,
): KiroModelList {
  const seam = kiroSessionTestSeam(env);
  if (seam) {
    return seam.models
      ? parseKiroModelList(JSON.stringify({ models: seam.models }))
      : { ok: false, reason: "Kiro did not answer" };
  }
  const result = spawnSync(cli, ["chat", "--list-models", "--format", "json"], {
    encoding: "utf-8",
    env: kiroEnv(env),
    timeout: timeoutMs,
  });
  if (result.status !== 0) return { ok: false, reason: "Kiro did not answer" };
  return parseKiroModelList(result.stdout ?? "");
}

export function readKiroPersonalSession(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = SETTINGS_TIMEOUT_MS,
): KiroPersonalSession {
  const seam = kiroSessionTestSeam(env);
  let values: Record<string, unknown>;
  if (seam) {
    if (seam.current === null) return { ok: false, reason: "Kiro settings were not readable" };
    values = seam.current ?? {};
  } else {
    const result = withEmptyFolder((folder) =>
      spawnSync(cli, ["settings", "list", "--format", "json"], {
        cwd: folder,
        encoding: "utf-8",
        env: kiroEnv(env),
        timeout: timeoutMs,
      })
    );
    if (result.status !== 0) return { ok: false, reason: "Kiro settings were not readable" };
    try {
      const parsed = JSON.parse((result.stdout ?? "").trim() || "{}") as unknown;
      values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return { ok: false, reason: "Kiro settings were not readable" };
    }
  }
  const model = values["chat.defaultModel"];
  const defaults = values["chat.modelDefaults"];
  // The saved model is printed and passed back to Kiro, so settings that name
  // anything but a plain model id are left alone, as if unreadable.
  if (typeof model === "string" && model && model !== "auto" && !isPlainKiroId(model)) {
    return { ok: false, reason: "Kiro settings were not readable" };
  }
  return {
    ok: true,
    model: typeof model === "string" && model && model !== "auto" ? model : null,
    modelDefaults: defaults && typeof defaults === "object" && !Array.isArray(defaults)
      ? defaults as Record<string, unknown>
      : {},
  };
}

// The person's current named model when the account still offers it, else
// Kiro's first model that is neither an experimental preview nor internal.
export function recommendedKiroModel(
  models: readonly KiroModel[],
  current: string | null,
): string | null {
  if (current && models.some((model) => model.id === current)) return current;
  return models.find((model) => model.tag === null)?.id ?? null;
}

export function mergedKiroModelDefaults(
  current: Record<string, unknown>,
  model: string,
  effort: KiroEffort,
): Record<string, unknown> {
  const entry = current[model] && typeof current[model] === "object" && !Array.isArray(current[model])
    ? current[model] as Record<string, unknown>
    : {};
  const output = entry.output_config && typeof entry.output_config === "object" &&
      !Array.isArray(entry.output_config)
    ? entry.output_config as Record<string, unknown>
    : {};
  return { ...current, [model]: { ...entry, output_config: { ...output, effort } } };
}

export function writeKiroPersonalSession(
  cli: string,
  write: KiroSessionWrite,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; reason: string; savedModel: boolean } {
  const calls: string[][] = [];
  if (write.model) calls.push(["settings", "chat.defaultModel", write.model]);
  if (write.effort) {
    // Merge onto the map as it is now, not as it was when the run began, so a
    // change made in Kiro meanwhile is kept; if it cannot be read, write nothing.
    const fresh = readKiroPersonalSession(cli, env);
    if (!fresh.ok) {
      return { ok: false, reason: "Kiro could not read your settings again before saving", savedModel: false };
    }
    calls.push([
      "settings",
      "chat.modelDefaults",
      JSON.stringify(mergedKiroModelDefaults(fresh.modelDefaults, write.effort.model, write.effort.effort)),
    ]);
  }
  const seam = kiroSessionTestSeam(env);
  let savedModel = false;
  for (const args of calls) {
    const failed = seam
      ? seam.failWrite === args[1]
      : withEmptyFolder((folder) =>
        spawnSync(cli, args, { cwd: folder, encoding: "utf-8", env: kiroEnv(env), timeout: SETTINGS_TIMEOUT_MS })
      ).status !== 0;
    if (failed) {
      return {
        ok: false,
        reason: `Kiro did not save the ${args[1] === "chat.defaultModel" ? "model" : "effort"}`,
        savedModel,
      };
    }
    if (seam?.writes && isSeamWriteLog(seam.writes)) appendFileSync(seam.writes, `${JSON.stringify(args)}\n`);
    if (args[1] === "chat.defaultModel") savedModel = true;
  }
  return { ok: true };
}

export const KIRO_AUTO_DEFINITION =
  "Kiro auto (Kiro's own default, where Kiro picks the model for each task)";

const KIRO_MODEL_IN_CHAT = "/model, then /model set-current-as-default to save it";

export type KiroSessionPlan = {
  cli: string;
  session: Extract<KiroPersonalSession, { ok: true }>;
  // The model to save, or undefined to keep the current one.
  setModel?: string;
  // Report what would be saved and write nothing.
  dryRun?: boolean;
  modelsCommand: string;
  // The command that repeats this request after a write Kiro refused, when
  // modelsCommand alone does not (it names the model).
  retryCommand?: string;
};

export type KiroSessionResult = {
  ok: boolean;
  lines: string[];
  model: string | null;
  effort: KiroEffort | null;
  saved: KiroSessionWrite;
  // A dry run's write, listed and not made.
  wouldSave?: KiroSessionWrite;
};

// Apply a session plan: save the model when one was chosen. The session model
// is Kiro CLI's alone (Kiro IDE does not read it), so the lines say where it
// applies. Every line is for the person.
// Never throws: the session is the person's own setting, saved after AI-DLC's
// own steps, so a Kiro problem is reported in one line and nothing AI-DLC
// already wrote is undone because of it.
export async function applyKiroSessionPlan(
  plan: KiroSessionPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KiroSessionResult> {
  try {
    return await applyPlan(plan, env);
  } catch (error) {
    return {
      ok: false,
      lines: [
        `Saving your personal Kiro settings stopped (${
          error instanceof Error ? error.message : String(error)
        }). Run \`${plan.retryCommand ?? plan.modelsCommand}\` to finish.`,
      ],
      model: plan.setModel ?? plan.session.model,
      effort: null,
      saved: {},
    };
  }
}

async function applyPlan(
  plan: KiroSessionPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KiroSessionResult> {
  const model = plan.setModel ?? plan.session.model;
  const lines: string[] = [];
  if (!model) return { ok: true, lines, model: null, effort: null, saved: {} };
  const write: KiroSessionWrite = {};
  if (plan.setModel && plan.setModel !== plan.session.model) write.model = plan.setModel;
  if (!write.model) return { ok: true, lines, model, effort: null, saved: {} };
  if (plan.dryRun) {
    lines.push(`Would save in your personal Kiro settings (${kiroPersonalSettingsPath(env)}):`);
    lines.push(`  model    ${write.model}`);
    return { ok: true, lines, model, effort: null, saved: {}, wouldSave: write };
  }
  const saved = writeKiroPersonalSession(plan.cli, write, env);
  if (!saved.ok) {
    lines.push(
      `${saved.reason}, so your personal Kiro settings are unchanged. Run \`${plan.retryCommand ?? plan.modelsCommand}\` to try again.`,
    );
    return { ok: false, lines, model, effort: null, saved: {} };
  }
  lines.push(
    `Saved in your personal Kiro settings (${kiroPersonalSettingsPath(env)}). Kiro CLI uses it in every project; Kiro IDE uses its own model picker:`,
  );
  lines.push(`  model    ${write.model}`);
  lines.push(`Change it any time with \`${plan.modelsCommand}\`, or inside Kiro CLI with ${KIRO_MODEL_IN_CHAT}.`);
  return { ok: true, lines, model, effort: null, saved: write };
}
