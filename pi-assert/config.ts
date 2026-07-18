import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// On-disk shape of a sectioned asserts.json file (project or global).
//
// This module is the single owner of the file format: reading, writing,
// section identification, and entry-shape validation.  Both the runtime
// loader (`engine.ts`) and the installer (`installer.ts`) build on it so
// the two never re-derive "what counts as a section" or "what makes an
// entry valid" independently.
// ---------------------------------------------------------------------------

/** Metadata keys that are not assert sections. */
const META_KEYS = new Set(["$schema", "repos"]);

/**
 * Shape of a sectioned asserts.json file.  `$schema` and `repos` are
 * metadata; every other object-typed top-level key is a section keyed by
 * source (`"local"` or an `owner/repo` repo key).
 */
export interface SectionedFile {
  $schema?: string;
  repos?: string[];
  local?: Record<string, unknown>;
  [section: string]: unknown;
}

/** One section yielded by `iterSections`: a source name and its entries. */
export interface SectionedSection {
  /** ` "local"` or a repo key like `"owner/repo"`. */
  source: string;
  entries: Record<string, unknown>;
}

/** Resolve the project `.pi/asserts.json` path for a given cwd. */
export function projectFilePath(cwd: string): string {
  return join(cwd, ".pi", "asserts.json");
}

/**
 * Path-based read of a sectioned asserts file.
 *
 * Returns `{}` when the file is missing.  **Throws** when the file exists
 * but cannot be parsed as a JSON object — the runtime loader relies on
 * that throw to surface per-file parse errors.  Best-effort callers
 * (the installer's install/remove/default writes) wrap this in a
 * try/catch to fall back to `{}`.
 */
export function readSectionedFile(path: string): SectionedFile {
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("asserts.json content is not a JSON object");
  }
  return parsed as SectionedFile;
}

/** Path-based write of a sectioned asserts file.  Creates parent dirs. */
export function writeSectionedFile(path: string, data: SectionedFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Never leave a truncated config behind if the process is interrupted.
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(temp, path);
}

/**
 * Yield the assert sections of a parsed file in insertion order.
 *
 * - Skips metadata keys (`$schema`, `repos`).
 * - Skips non-object values.
 * - When `knownRepos` is provided, yields only sections in that set
 *   (the runtime loader filters to repos declared in the project file,
 *   plus `"local"`).  When omitted, yields every object-typed section
 *   (backward-compatible with older global files).
 */
/** Validate the complete runtime file shape; malformed guards must fail closed. */
export function validateSectionedFile(file: SectionedFile): string | null {
  if (file.$schema !== undefined && typeof file.$schema !== "string") {
    return '"$schema" must be a string';
  }
  if (file.repos !== undefined &&
      (!Array.isArray(file.repos) || !file.repos.every((repo) =>
        typeof repo === "string" && /^[^/]+\/[^/]+$/.test(repo)) ||
       new Set(file.repos).size !== file.repos.length)) {
    return '"repos" must be a unique array of owner/repo strings';
  }
  for (const [source, entries] of Object.entries(file)) {
    if (META_KEYS.has(source)) continue;
    if (!isPlainObject(entries)) return `section "${source}" must be an object`;
    for (const [name, entry] of Object.entries(entries)) {
      if (!validateRuleEntry(entry)) {
        return `entry "${source}/${name}" does not match the assert or preset schema`;
      }
    }
  }
  return null;
}

export function iterSections(
  file: SectionedFile,
  knownRepos?: Set<string>,
): SectionedSection[] {
  const hasKnown = knownRepos !== undefined;
  const out: SectionedSection[] = [];

  for (const [section, entries] of Object.entries(file)) {
    if (META_KEYS.has(section)) continue;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) continue;
    if (hasKnown && !knownRepos!.has(section)) continue;
    out.push({ source: section, entries: entries as Record<string, unknown> });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry-shape validation (shared by the runtime loader and the installer)
// ---------------------------------------------------------------------------

/**
 * Fields shared by every assert entry, whether on disk or in a rules repo.
 * `description` is required everywhere: on-disk entries need it for the
 * /asserts panel, and rule-repo entries use it to drive the install picker.
 */
export interface EntryFields {
  description: string;
  hook: "tool_call" | "tool_result" | "agent_end";
  filter?: Record<string, string | number | boolean | null | (string | number | boolean | null)[]>;
  when?: string;
  shell: string;
  default?: boolean;
}

const ASSERT_KEYS = new Set(["description", "hook", "filter", "when", "shell", "default"]);
const PRESET_KEYS = new Set(["description", "preset", "default"]);
const HOOKS = new Set(["tool_call", "tool_result", "agent_end"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilterValue(value: unknown): boolean {
  const scalar = (v: unknown): v is string | number | boolean | null =>
    v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
}

/**
 * Type guard for an assert entry's shape.
 *
 * Requires `description`, `hook`, and `shell` to be strings.  Used by
 * both the runtime loader (on-disk entries) and the installer
 * (rule-repo entries) — description is required in both.
 */
export function validateEntryShape(def: unknown): def is EntryFields {
  if (!isPlainObject(def)) return false;
  const d = def;
  if (Object.keys(d).some((key) => !ASSERT_KEYS.has(key))) return false;
  if (typeof d.description !== "string" || typeof d.shell !== "string") return false;
  if (typeof d.hook !== "string" || !HOOKS.has(d.hook)) return false;
  if (d.when !== undefined && typeof d.when !== "string") return false;
  if (d.default !== undefined && typeof d.default !== "boolean") return false;
  if (d.filter !== undefined &&
      (!isPlainObject(d.filter) || !Object.values(d.filter).every(isFilterValue))) return false;
  // A rule is exactly one kind; don't let a valid assert hide a preset field.
  return d.preset === undefined;
}

// ---------------------------------------------------------------------------
// Preset entry-shape validation
//
// A preset is a named bundle of asserts: instead of `shell` + `when`, it holds
// a `preset` array of qualified `"source/name"` refs.  Presets and asserts
// are mutually exclusive (a preset carrying `shell`/`hook`/`when`/`filter`
// is rejected), so `validateRuleEntry` is unambiguous.  Shared by the runtime
// loader (`engine.ts`) and the installer (`installer.ts`).
// ---------------------------------------------------------------------------

/**
 * Enforce the source *shape* of a preset ref, not just slash count:
 * `local/name` (1 slash, source "local") or `owner/repo/name` (2 slashes).
 * A bare `owner/name` is always-dangling (source "owner" isn't a section) and
 * `local/a/b` is always-dangling (source "local/a"), so reject them at write
 * time instead of installing them as inert `§` presets.
 *
 * The second alternative's `(?!local\/)` lookahead reserves `local` for the
 * `local/name` form: without it, `local/a/b` would match the 3-segment branch
 * (owner "local") and slip through, contradicting the always-dangling rule.
 * `local` is a reserved section name, so no repo owner may be `local`.
 */
export const REF_RE =
  /^local\/[A-Za-z0-9._-]+$|^(?!local\/)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Fields of a preset entry, on disk or in a rules repo. */
export interface PresetFields {
  description: string;
  preset: string[];
  default?: boolean;
}

/**
 * Type guard for a preset entry's shape.
 *
 * Requires `description` (string) and `preset` (array of `REF_RE`-shaped
 * strings).  An empty array is valid — `n`-created presets start at
 * `preset: []`.  Mutual exclusivity with the assert shape is enforced by
 * rejecting `shell`/`hook`/`when`/`filter`: a preset carrying any of those
 * fails validation loudly instead of being silently dropped by `cleanEntry`'s
 * preset branch (which writes only `description`/`preset`/`default`).
 */
export function validatePresetShape(def: unknown): def is PresetFields {
  if (!isPlainObject(def)) return false;
  const d = def;
  if (Object.keys(d).some((key) => !PRESET_KEYS.has(key))) return false;
  if (typeof d.description !== "string") return false;
  if (d.default !== undefined && typeof d.default !== "boolean") return false;
  // Empty array is valid: `n`-created presets start at preset: [].
  if (!Array.isArray(d.preset) || !d.preset.every((x) => typeof x === "string")) {
    return false;
  }
  if (!d.preset.every((x) => REF_RE.test(x))) return false; // enforce source/name
  return true;
}

/** Tag identifying which kind of rule entry `validateRuleEntry` matched. */
export type RuleEntryKind = { kind: "assert" } | { kind: "preset" };

/**
 * Classify an unknown entry as an assert or a preset (or neither).
 *
 * Preset is checked first: the two shapes are mutually exclusive (a preset
 * rejects `shell`/`hook`/`when`/`filter`, an assert lacks `preset`), so the
 * order is unambiguous.  Returns `null` when the entry matches neither shape.
 *
 * Returns a *tag* (`RuleEntryKind | null`), not a type guard on `def`, so `def`
 * stays `unknown` to the caller — the installer uses the tag to dispatch and
 * re-validates with the individual guard where it needs `def` narrowed.
 */
/** Canonical identity for an entry. Names are only unique within a source. */
export function entryKey(source: string, name: string): string {
  return `${source}\x00${name}`;
}

export function validateRuleEntry(def: unknown): RuleEntryKind | null {
  if (validatePresetShape(def)) return { kind: "preset" };
  if (validateEntryShape(def)) return { kind: "assert" };
  return null;
}
