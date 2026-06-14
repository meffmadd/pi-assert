import { exec } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Assert {
  /** Unique name of this assert. */
  name: string;
  /** Source section: "local" or a repo key like "owner/repo". */
  source: string;
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

/** Raw shape of each assert value before we attach the key as name. */
interface AssertDefinition {
  hook: string;
  filter?: Record<string, unknown>;
  /** Optional precondition shell command. Only runs `shell` if this exits 0. */
  when?: string;
  shell: string;
  /** If true, this assert is active by default for new sessions. Defaults to false. */
  default?: boolean;
}

/**
 * Shape of an asserts.json file.
 *
 * Top-level keys are section names:
 * - `"local"` → user-defined asserts (protected from removal)
 * - `"$schema"` → ignored
 * - `"repos"` → array of known repo keys (e.g. ["meffmadd/pi-assert-rules"])
 * - `"owner/repo"` → asserts installed from that repo (removable)
 */
interface AssertsFile {
  $schema?: string;
  local?: Record<string, AssertDefinition>;
  repos?: string[];
  [repo: string]: Record<string, AssertDefinition> | string | string[] | undefined;
}

/** Structured environment passed to shell commands for tool_call hooks. */
export interface AssertEnv {
  PI_TOOL_NAME: string;
  PI_TOOL_CALL_ID: string;
  PI_TOOL_INPUT: string;
  PI_CWD: string;
}

/** Structured environment passed to shell commands for agent_end hooks. */
export interface AgentEndEnv {
  PI_EVENT: string;
  PI_CWD: string;
}

/** Structured environment passed to shell commands for tool_result hooks. */
export interface ToolResultEnv {
  PI_TOOL_NAME: string;
  PI_TOOL_CALL_ID: string;
  PI_TOOL_INPUT: string;
  PI_TOOL_RESULT: string;
  PI_TOOL_IS_ERROR: "true" | "false";
  PI_CWD: string;
}

/** Minimal shape of the tool_call event we consume. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** Minimal shape of the agent_end event we consume. */
export interface AgentEndEvent {
  // agent_end has .messages but we don't need them for env/filter
}

// Content block types come from pi-ai (transitive dep of pi-coding-agent).

/** Minimal shape of the tool_result event we consume. */
export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details?: unknown;
}

/** Patch returned from a tool_result handler. */
export interface ToolResultPatch {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}

/** Minimal shape of the extension context we consume. */
export interface ExtensionContext {
  cwd: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface ResolvedAssert {
  name: string;
  source: string;
  def: AssertDefinition;
}

/** A single per-file parse failure. */
export interface LoadError {
  /** Absolute path of the file that failed. */
  path: string;
  /** Short reason suitable for a notification (e.g. SyntaxError message). */
  reason: string;
}

/**
 * Thrown by `loadAsserts` when one or both asserts.json files cannot be
 * parsed.  Carries a list of per-file errors so the UI can name the
 * offending file(s) and reason(s) in a single notification.
 *
 * The caller is expected to treat any instance of this error as a
 * hard-fail: do not apply partial results.
 */
export class AssertsParseError extends Error {
  readonly errors: LoadError[];
  constructor(errors: LoadError[]) {
    super(
      `Failed to parse ${errors.length} asserts.json file${errors.length === 1 ? "" : "s"}`,
    );
    this.name = "AssertsParseError";
    this.errors = errors;
  }
}

/**
 * Load asserts from `.pi/asserts.json` (project) and `~/.pi/asserts.json`
 * (global).  Project-level entries override global entries by source + name.
 *
 * Throws `AssertsParseError` if either file fails to parse.  No asserts are
 * returned in that case — callers must treat the error as a hard-fail and
 * not apply partial results.
 */
export function loadAsserts(cwd: string): Assert[] {
  const merged = new Map<string, ResolvedAssert>();
  const errors: LoadError[] = [];

  // Read repos from project file to build known set (also applies to global)
  const projectPath = join(cwd, ".pi", "asserts.json");
  let knownRepos: Set<string> | undefined;
  if (existsSync(projectPath)) {
    try {
      const raw = JSON.parse(
        readFileSync(projectPath, "utf-8"),
      ) as Record<string, unknown>;
      if (Array.isArray(raw.repos)) {
        knownRepos = new Set(
          (raw.repos as string[]).filter(
            (r) => typeof r === "string" && r.includes("/"),
          ),
        );
        knownRepos.add("local");
      }
    } catch (err) {
      // Record and skip the repos pre-read; the full read below will
      // record the same error if the file is still broken.
      errors.push({ path: projectPath, reason: formatParseError(err) });
    }
  }

  // 1. Global
  const globalPath = join(homedir(), ".pi", "asserts.json");
  if (existsSync(globalPath)) {
    try {
      for (const entry of readSections(globalPath, knownRepos)) {
        merged.set(key(entry), entry);
      }
    } catch (err) {
      // Replace any pre-read error for the same path so we don't double-count
      upsertError(errors, {
        path: globalPath,
        reason: formatParseError(err),
      });
    }
  }

  // 2. Project (overrides global by source+name)
  if (existsSync(projectPath)) {
    try {
      for (const entry of readSections(projectPath, knownRepos)) {
        merged.set(key(entry), entry);
      }
    } catch (err) {
      upsertError(errors, {
        path: projectPath,
        reason: formatParseError(err),
      });
    }
  }

  if (errors.length > 0) {
    throw new AssertsParseError(errors);
  }

  return Array.from(merged.values()).map(({ name, source, def }) => ({
    name,
    source,
    hook: def.hook,
    filter: def.filter,
    when: def.when,
    shell: def.shell,
    default: def.default ?? false,
  }));
}

/** Extract a short, human-readable reason from a JSON parse error. */
function formatParseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Insert a LoadError, replacing any existing entry for the same path. */
function upsertError(errors: LoadError[], next: LoadError): void {
  for (let i = 0; i < errors.length; i++) {
    if (errors[i].path === next.path) {
      errors[i] = next;
      return;
    }
  }
  errors.push(next);
}

function key(e: ResolvedAssert): string {
  return `${e.source}\x00${e.name}`;
}

/** Flatten a sectioned asserts file into (source, name, def) triples. */
function readSections(
  path: string,
  knownRepos?: Set<string>,
): ResolvedAssert[] {
  const content = readFileSync(path, "utf-8");
  const raw = JSON.parse(content) as Record<string, unknown>;
  const results: ResolvedAssert[] = [];

  // If knownRepos is provided, only accept those sections.
  // If undefined, accept every object-typed section (backward compat).
  const hasKnown = knownRepos !== undefined;

  for (const [section, entries] of Object.entries(raw)) {
    // Skip metadata keys (but NOT "local" — that's a real section)
    if (section === "$schema" || section === "repos") continue;
    if (typeof entries !== "object" || entries === null) continue;

    // Filter to known repos when the caller provides a set
    if (hasKnown && !knownRepos.has(section)) continue;

    for (const [name, def] of Object.entries(
      entries as Record<string, unknown>,
    )) {
      if (isValidAssert(def)) {
        results.push({ name, source: section, def });
      }
    }
  }

  return results;
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
 * Check whether the optional filter matches a candidate record.
 * Every key in the filter must equal the corresponding value in
 * the candidate.  No filter → always matches.
 *
 * For tool_call hooks, the candidate is `{ toolName, ...event.input }`.
 * For tool_result hooks, the candidate is `{ toolName, ...event.input }`.
 * For agent_end hooks, the candidate is `{ event: "agent_end" }`.
 */
export function matchFilter(
  filter: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>,
): boolean {
  if (!filter) return true;

  for (const key of Object.keys(filter)) {
    if (candidate[key] !== filter[key]) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Environment builder
// ---------------------------------------------------------------------------

/**
 * Build the environment variables passed to shell commands for tool_call hooks.
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

/**
 * Build the environment variables passed to shell commands for agent_end hooks.
 */
export function buildAgentEndEnv(
  _event: AgentEndEvent,
  ctx: ExtensionContext,
): AgentEndEnv {
  return {
    PI_EVENT: "agent_end",
    PI_CWD: ctx.cwd,
  };
}

/**
 * Build the environment variables passed to shell commands for tool_result hooks.
 *
 * `PI_TOOL_RESULT` is the concatenation of all text content blocks joined by
 * `\n`. Image content blocks are skipped (no textual representation to grep
 * against).
 */
export function buildResultEnv(
  event: ToolResultEvent,
  ctx: ExtensionContext,
): ToolResultEnv {
  const textSegments = event.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text);

  return {
    PI_TOOL_NAME: event.toolName,
    PI_TOOL_CALL_ID: event.toolCallId,
    PI_TOOL_INPUT: JSON.stringify(event.input),
    PI_TOOL_RESULT: textSegments.join("\n"),
    PI_TOOL_IS_ERROR: event.isError ? "true" : "false",
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
