import { exec } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Assert {
  /** Unique name of this assert. */
  name: string;
  /** Pi event name to intercept (e.g. "tool_call"). */
  hook: string;
  /** Optional key-value filter matched against { toolName, ...event.input }. */
  filter?: Record<string, unknown>;
  /** Optional precondition shell command. Only runs the main `shell` if this exits 0. */
  when?: string;
  /** Shell command string whose exit code decides pass/fail. */
  shell: string;
  /** Whether this assert is active by default for new sessions (default false). */
  default: boolean;
}

/** Raw shape of each value in asserts.json before we attach the key as name. */
interface AssertDefinition {
  hook: string;
  filter?: Record<string, unknown>;
  /** Optional precondition shell command. Only runs `shell` if this exits 0. */
  when?: string;
  shell: string;
  /** If true, this assert is active by default for new sessions. Defaults to false. */
  default?: boolean;
}

/** Shape of an asserts.json file (top-level object). */
interface AssertsFile {
  [name: string]: AssertDefinition;
}

/** Structured environment passed to every shell command. */
export interface AssertEnv {
  PI_TOOL_NAME: string;
  PI_TOOL_CALL_ID: string;
  PI_TOOL_INPUT: string;
  PI_CWD: string;
}

/** Minimal shape of the tool_call event we consume. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** Minimal shape of the extension context we consume. */
export interface ExtensionContext {
  cwd: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load asserts from `.pi/asserts.json` (project) and `~/.pi/asserts.json`
 * (global).  Project-level keys override global keys (shallow merge per name).
 */
export function loadAsserts(cwd: string): Assert[] {
  const merged: Record<string, AssertDefinition> = {};

  // 1. Global
  const globalPath = join(homedir(), ".pi", "asserts.json");
  if (existsSync(globalPath)) {
    const raw = parseAssertsFile(globalPath);
    for (const [name, def] of Object.entries(raw)) {
      if (isValidAssert(def)) merged[name] = def;
    }
  }

  // 2. Project (overrides global by key)
  const projectPath = join(cwd, ".pi", "asserts.json");
  if (existsSync(projectPath)) {
    const raw = parseAssertsFile(projectPath);
    for (const [name, def] of Object.entries(raw)) {
      if (isValidAssert(def)) merged[name] = def;
    }
  }

  return Object.entries(merged).map(([name, def]) => ({
    name,
    hook: def.hook,
    filter: def.filter,
    when: def.when,
    shell: def.shell,
    default: def.default ?? false,
  }));
}

function parseAssertsFile(path: string): AssertsFile {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as AssertsFile;
}

function isValidAssert(def: unknown): def is AssertDefinition {
  if (typeof def !== "object" || def === null) return false;
  const d = def as Record<string, unknown>;
  return typeof d.hook === "string" && typeof d.shell === "string";
}

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

/**
 * Check whether the optional filter matches the tool_call event.
 * Every key in the filter must equal the corresponding value in
 * `{ toolName, ...event.input }`.  No filter → always matches.
 */
export function matchFilter(
  filter: Record<string, unknown> | undefined,
  event: ToolCallEvent,
): boolean {
  if (!filter) return true;

  const candidate: Record<string, unknown> = {
    toolName: event.toolName,
    ...event.input,
  };

  for (const key of Object.keys(filter)) {
    if (candidate[key] !== filter[key]) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Environment builder
// ---------------------------------------------------------------------------

/**
 * Build the environment variables passed to every shell command.
 * This is the single place to add new variables in the future.
 */
export function buildEnv(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): AssertEnv {
  return {
    PI_TOOL_NAME: event.toolName,
    PI_TOOL_CALL_ID: event.toolCallId,
    PI_TOOL_INPUT: JSON.stringify(event.input),
    PI_CWD: ctx.cwd,
  };
}

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Run a shell command and return `true` if it exits with code 0 (pass).
 *
 * Uses `child_process.exec` so pipes, redirects, `&&`, `||` all work via a
 * real shell — just like pi's bash tool.  `"false"` is handled as a normal
 * command: the Unix `false` binary exits 1 → blocked.
 */
export interface ShellResult {
  passed: boolean;
  code: number | null;
}

export function evaluateShell(
  shell: string,
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve, reject) => {
    // Merge our env on top of process.env so the shell inherits PATH etc.
    const mergedEnv = { ...process.env, ...env };

    const child = exec(shell, {
      env: mergedEnv,
      timeout: timeoutMs,
      signal,
      // shell: defaults to /bin/sh on Unix, which is what we want
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // If the user aborts (AbortError), treat it as a block.
      if (err.name === "AbortError" || (signal?.aborted ?? false)) {
        resolve({ passed: false, code: null });
        return;
      }
      if (err.killed) {
        // Timeout or signal killed the process → block.
        resolve({ passed: false, code: null });
        return;
      }
      // Other errors (e.g. shell binary not found) → block.
      resolve({ passed: false, code: null });
    });

    child.on("close", (code: number | null) => {
      // exit 0 → pass, everything else → block
      resolve({ passed: code === 0, code });
    });
  });
}
