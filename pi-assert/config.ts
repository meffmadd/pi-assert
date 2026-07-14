import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  if (typeof parsed !== "object" || parsed === null) {
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
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
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
export function iterSections(
  file: SectionedFile,
  knownRepos?: Set<string>,
): SectionedSection[] {
  const hasKnown = knownRepos !== undefined;
  const out: SectionedSection[] = [];

  for (const [section, entries] of Object.entries(file)) {
    if (META_KEYS.has(section)) continue;
    if (typeof entries !== "object" || entries === null) continue;
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
  hook: string;
  filter?: Record<string, unknown>;
  when?: string;
  shell: string;
  default?: boolean;
}

/**
 * Type guard for an assert entry's shape.
 *
 * Requires `description`, `hook`, and `shell` to be strings.  Used by
 * both the runtime loader (on-disk entries) and the installer
 * (rule-repo entries) — description is required in both.
 */
export function validateEntryShape(def: unknown): def is EntryFields {
  if (typeof def !== "object" || def === null) return false;
  const d = def as Record<string, unknown>;
  if (typeof d.description !== "string") return false;
  if (typeof d.hook !== "string" || typeof d.shell !== "string") return false;
  return true;
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
  if (typeof def !== "object" || def === null) return false;
  const d = def as Record<string, unknown>;
  if (typeof d.description !== "string") return false;
  // Empty array is valid: `n`-created presets start at preset: [].
  if (!Array.isArray(d.preset) || !d.preset.every((x) => typeof x === "string")) {
    return false;
  }
  if (!d.preset.every((x) => REF_RE.test(x))) return false; // enforce source/name
  if (typeof d.shell === "string" || typeof d.hook === "string") return false; // mutual excl.
  // `when`/`filter` are assert-only.  Reject them so a preset carrying either
  // fails validation loudly instead of being silently dropped by `cleanEntry`'s
  // preset branch (which writes only description/preset/default).
  if (typeof d.when === "string" || d.filter !== undefined) return false;
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
export function validateRuleEntry(def: unknown): RuleEntryKind | null {
  if (validatePresetShape(def)) return { kind: "preset" };
  if (validateEntryShape(def)) return { kind: "assert" };
  return null;
}
