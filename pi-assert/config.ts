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
 * `description` is optional on disk but required in rule-repo entries
 * (where it drives the install picker).
 */
export interface EntryFields {
  description?: string;
  hook: string;
  filter?: Record<string, unknown>;
  when?: string;
  shell: string;
  default?: boolean;
}

/**
 * Type guard for an assert entry's shape.
 *
 * Requires `hook` and `shell` to be strings.  Pass
 * `{ requireDescription: true }` to additionally require a string
 * `description` — used by the installer, which only lists entries that
 * have a human-readable description for the picker.
 */
export function validateEntryShape(def: unknown): def is EntryFields;
export function validateEntryShape(
  def: unknown,
  opts: { requireDescription: true },
): def is EntryFields & { description: string };
export function validateEntryShape(
  def: unknown,
  opts?: { requireDescription?: boolean },
): def is EntryFields {
  if (typeof def !== "object" || def === null) return false;
  const d = def as Record<string, unknown>;
  if (typeof d.hook !== "string" || typeof d.shell !== "string") return false;
  if (opts?.requireDescription && typeof d.description !== "string") {
    return false;
  }
  return true;
}
