import { isDeepStrictEqual } from "node:util";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
  projectFilePath,
  readSectionedFile,
  writeSectionedFile,
  validateEntryShape,
  type SectionedFile,
} from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in a rules/*.json file from a pi-assert-rules repo. */
export interface RuleEntry {
  /** Human-readable description shown in the install TUI and persisted on install. */
  description: string;
  hook: string;
  filter?: Record<string, unknown>;
  when?: string;
  shell: string;
  default?: boolean;
}

/** Top-level shape of a rules/*.json file. */
export type RuleEntries = Record<string, RuleEntry>;

/** A `.json` rule file under `rules/` in a pi-assert-rules repo. */
export interface RuleFile {
  /**
   * Relative path under `rules/` without the `.json` extension.
   * Flat files keep a bare name ("defaults"); nested files keep the
   * intermediate directories ("security/writes", "git/no-force-push").
   * Used as the picker label and the assert-entry title.
   */
  name: string;
  /** Full path within the repo (e.g. "rules/security/writes.json"). */
  path: string;
  /** Git blob SHA from the tree (for future version tracking). */
  sha: string;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

const API_BASE = "https://api.github.com";

/**
 * List `.json` rule files under `rules/` in a GitHub repo, recursively.
 *
 * Uses the Git Trees API with `recursive=1` so a single round trip
 * enumerates the whole tree regardless of nesting depth.  The Contents
 * API only lists immediate children, so it can't see subdirectories.
 *
 * GitHub accepts a branch name directly as the tree SHA (it resolves
 * the ref server-side), so no separate ref-resolve hop is needed.
 * A leading `refs/heads/` is stripped if present so callers can pass
 * either a bare branch ("main") or a full ref ("refs/heads/main").
 *
 * Returns blobs whose path starts with `rules/` and ends in `.json`,
 * sorted by path.  The `name` field is the path relative to `rules/`
 * with the `.json` extension stripped, so nested files keep their
 * intermediate directories (e.g. "security/writes").
 *
 * Throws loudly if the tree response is `truncated` (the repo has more
 * than ~1000 entries) rather than silently returning a partial list —
 * a rules repo should never hit this, and a partial drop would be a
 * silent-failure bug of exactly the kind this function exists to avoid.
 */
export async function fetchRuleFiles(
  repo: string,
  ref = "main",
): Promise<RuleFile[]> {
  const branch = ref.replace(/^refs\/heads\//, "");
  const url = `${API_BASE}/repos/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${url}`);
  }

  const body = (await res.json()) as {
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated?: boolean;
  };

  if (body.truncated) {
    throw new Error(
      `Rule tree for ${repo} is too large for a single API response ` +
        `(truncated). Reorganise so rules/ has fewer than ~1000 files.`,
    );
  }

  return body.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.startsWith("rules/") &&
        item.path.endsWith(".json"),
    )
    .map((item) => ({
      name: item.path.slice("rules/".length).replace(/\.json$/, ""),
      path: item.path,
      sha: item.sha,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Fetch and parse a single rules/*.json file from a GitHub repo.
 *
 * Returns only entries that have a `description`, `hook`, and `shell`
 * (all required by the schema).
 */
export async function fetchRuleFile(
  repo: string,
  path: string,
  ref = "main",
): Promise<RuleEntries> {
  // Encode each path segment separately so slashes are preserved —
  // `encodeURIComponent(path)` would turn "rules/security/writes.json"
  // into "rules%2Fsecurity%2Fwrites.json", which the Contents API does
  // not reliably accept for nested paths.
  const urlPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${API_BASE}/repos/${repo}/contents/${urlPath}?ref=${ref}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${url}`);
  }

  const item = (await res.json()) as GitHubFileItem;

  if (item.type !== "file" || !item.content) {
    throw new Error("Not a file or missing content");
  }

  const raw = Buffer.from(item.content, "base64").toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse JSON from GitHub file");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("File content is not a JSON object");
  }

  const entries: RuleEntries = {};
  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    if (validateEntryShape(def)) {
      entries[name] = def;
    }
  }

  return entries;
}

interface GitHubFileItem {
  type: string;
  content?: string;
  encoding?: string;
}

// ---------------------------------------------------------------------------
// Repo-wide entry fetch (for orphaned detection)
// ---------------------------------------------------------------------------

/**
 * Session cache of `fetchRepoEntries` promises, keyed by `repo@ref`.
 *
 * Caching the *promise* (not the result) means concurrent callers share one
 * fetch round, and the `/asserts` panel never re-fetches the same repo in a
 * session.  Rejections are evicted so a transient network failure is
 * retryable on the next open.
 */
const repoEntriesCache = new Map<string, Promise<Map<string, RuleEntry>>>();

/**
 * Fetch every entry from every `rules/*.json` file in a repo and return a
 * flat `name → RuleEntry` map.
 *
 * One `fetchRuleFiles` round (the tree) plus one `fetchRuleFile` per file,
 * all in parallel.  Used by the `/asserts` panel to detect orphaned asserts
 * (installed names missing from the repo).  Results are session-cached per
 * `repo@ref` so re-opening the panel doesn't re-fetch.
 *
 * On failure the cache entry is evicted (so the next call retries) and the
 * error propagates to the caller, which degrades to "no orphaned badges".
 */
export function fetchRepoEntries(
  repo: string,
  ref = "main",
): Promise<Map<string, RuleEntry>> {
  const key = `${repo}@${ref}`;
  let cached = repoEntriesCache.get(key);
  if (cached) return cached;

  cached = (async () => {
    const files = await fetchRuleFiles(repo, ref);
    const entries = new Map<string, RuleEntry>();
    await Promise.all(
      files.map(async (f) => {
        const fileEntries = await fetchRuleFile(repo, f.path, ref);
        for (const [name, entry] of Object.entries(fileEntries)) {
          entries.set(name, entry);
        }
      }),
    );
    return entries;
  })().catch((err) => {
    // Evict on failure so the next open retries instead of caching the error.
    repoEntriesCache.delete(key);
    throw err;
  });

  repoEntriesCache.set(key, cached);
  return cached;
}

/** Clear the `fetchRepoEntries` session cache (test helper). */
export function clearRepoEntriesCache(): void {
  repoEntriesCache.clear();
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

/**
 * Best-effort project-file read: returns `{}` when the file is missing or
 * unparseable (matches the historical install/remove behaviour — install
 * should create the file, remove should no-op, never throw on a broken
 * config).  The runtime loader (`engine.ts`) instead uses `readSectionedFile`
 * directly so it can surface parse errors.
 */
function readProjectFile(cwd: string): SectionedFile {
  try {
    return readSectionedFile(projectFilePath(cwd));
  } catch {
    return {};
  }
}

/** Best-effort path-based read (for `setAssertDefault`, which takes a path). */
function readProjectFileAt(path: string): SectionedFile {
  try {
    return readSectionedFile(path);
  } catch {
    return {};
  }
}

function writeProjectFile(cwd: string, data: SectionedFile): void {
  writeSectionedFile(projectFilePath(cwd), data);
}

/**
 * Install a single assert into the project's `.pi/asserts.json`
 * under the given `repo` key (e.g. "meffmadd/pi-assert-rules").
 *
 * Only schema-valid fields are persisted (including `description`,
 * which is required on disk).
 *
 * Returns `true` if an existing assert with the same `name` was
 * overwritten, `false` for a fresh install.  Callers with UI access
 * can surface the overwrite as a warning notification.
 */
export function installRule(
  cwd: string,
  repo: string,
  name: string,
  entry: RuleEntry,
): boolean {
  const current = readProjectFile(cwd);

  // Ensure repo is in the repos array
  if (!current.repos) current.repos = [];
  if (!current.repos.includes(repo)) {
    current.repos.push(repo);
  }

  // Ensure the repo section exists
  if (!current[repo]) {
    current[repo] = {};
  }
  const section = current[repo] as Record<string, unknown>;

  // Warn if overwriting — surfaced by callers via a TUI notification
  // (console.warn is invisible in the TUI).
  const overwritten = section[name] !== undefined;

  section[name] = cleanEntry(entry);
  writeProjectFile(cwd, current);
  return overwritten;
}

/**
 * Build the canonical assert record written to disk: only schema-valid
 * fields, in a stable key order (`description`, `hook`, `shell`, then the
 * optional `filter`/`when`/`default` when present).
 *
 * The single owner of the on-disk record shape — both `installRule` and
 * `updateRule` build on it so an install and an update produce byte-identical
 * output for the same entry (per the project's "prefer one shared
 * implementation" rule).  Omitted optional fields are dropped entirely,
 * matching the installer's "omit when absent" convention.
 */
export function cleanEntry(entry: RuleEntry): Record<string, unknown> {
  const clean: Record<string, unknown> = {
    description: entry.description,
    hook: entry.hook,
    shell: entry.shell,
  };
  if (entry.filter !== undefined) clean.filter = entry.filter;
  if (entry.when !== undefined) clean.when = entry.when;
  if (entry.default !== undefined) clean.default = entry.default;
  return clean;
}

// ---------------------------------------------------------------------------
// Outdated detection (pure: no I/O)
// ---------------------------------------------------------------------------

/**
 * Minimal shape needed to compute an assert's content signature.  Both
 * {@link RuleEntry} (repo side) and the runtime `Assert` (installed side)
 * satisfy it, so the comparison functions stay decoupled from `engine.ts`.
 */
export interface SignableEntry {
  description: string;
  hook: string;
  shell: string;
  filter?: Record<string, unknown>;
  when?: string;
}

/**
 * Canonical content signature of an assert, used for outdated detection.
 *
 * Excludes `default` (a local-only preference, never a repo-driven change)
 * and includes only the repo-driven fields: `description`, `hook`, `shell`,
 * and `filter`/`when` **when present**.  Omitted optional fields are dropped
 * entirely (never emitted as `undefined`) so a deep-equal of two signatures
 * treats "absent" on both sides as equal — an installed entry with no
 * `filter` is up to date with a repo entry that also has none.
 *
 * Keys are emitted in a stable order so callers that want byte-stable output
 * (e.g. `JSON.stringify`) get it, though the comparison itself uses
 * key-order-independent `isDeepStrictEqual`.
 */
export function entryContentSignature(
  entry: SignableEntry,
): Record<string, unknown> {
  const sig: Record<string, unknown> = {
    description: entry.description,
    hook: entry.hook,
    shell: entry.shell,
  };
  if (entry.filter !== undefined) sig.filter = entry.filter;
  if (entry.when !== undefined) sig.when = entry.when;
  return sig;
}

/**
 * `true` when the installed entry's repo-driven content differs from the
 * repo entry (i.e. the installed assert is outdated).
 *
 * Compares content signatures (which exclude `default`), so a `default`-only
 * difference is never an update.  Uses `isDeepStrictEqual` so filter objects
 * match regardless of key order.
 */
export function entryNeedsUpdate(
  installed: SignableEntry,
  repo: SignableEntry,
): boolean {
  return !isDeepStrictEqual(
    entryContentSignature(installed),
    entryContentSignature(repo),
  );
}

/** Tri-state classification of a repo entry against the local install. */
export type EntryState = "not-installed" | "outdated" | "installed";

/**
 * Classify a repo entry against the installed assert of the same name.
 *
 * - `undefined` installed → `"not-installed"` (name absent locally).
 * - installed, content differs → `"outdated"` (update available).
 * - installed, content equal → `"installed"` (up to date).
 *
 * `default` is excluded from the comparison (a local toggle is never an
 * update).  Pure: the caller resolves the installed entry by name and
 * passes it in, so this function knows nothing about files or maps.
 */
export function classifyEntry(
  repoEntry: SignableEntry,
  installed: SignableEntry | undefined,
): EntryState {
  if (installed === undefined) return "not-installed";
  return entryNeedsUpdate(installed, repoEntry) ? "outdated" : "installed";
}

/**
 * Remove a named assert from a specific repo section.
 * Prunes the section key entirely if it becomes empty.
 * Returns true if the assert was found and removed.
 */
export function removeRule(
  cwd: string,
  repo: string,
  name: string,
): boolean {
  const current = readProjectFile(cwd);

  const section = current[repo] as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object" || !(name in section)) {
    return false;
  }

  delete section[name];

  // Prune empty section
  if (Object.keys(section).length === 0) {
    delete current[repo];
  }

  writeProjectFile(cwd, current);
  return true;
}

/**
 * Update an installed assert in place to match a repo entry's content.
 *
 * Path-aware: writes to the file the assert was loaded from (`path`, which
 * may be the project or the global file), so a project override isn't
 * silently rewritten into the global file (or vice versa).  This is the key
 * difference from {@link installRule}, which always writes the project file.
 *
 * Preserves the on-disk `default` flag: `default` is a local-only preference
 * (excluded from the content signature), so an update never clobbers a user's
 * toggle.  The repo entry's own `default` (if any) is ignored in favour of
 * the installed value.
 *
 * Returns `true` when the assert was found and updated, `false` when the
 * section or name is missing from the file (stale — the caller should treat
 * it as a fresh install instead).
 */
export function updateRule(
  path: string,
  source: string,
  name: string,
  entry: RuleEntry,
): boolean {
  const current = readProjectFileAt(path);

  const section = current[source] as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object" || !(name in section)) {
    return false;
  }

  const existing = section[name];
  const existingDefault =
    typeof existing === "object" && existing !== null
      ? (existing as Record<string, unknown>).default
      : undefined;

  // Preserve the installed `default` (a local toggle), ignoring the repo
  // entry's own `default`.  `cleanEntry` omits `default` when `undefined`,
  // so passing `true` only when the install actually had it keeps the
  // on-disk shape stable across an update.
  section[name] = cleanEntry({
    description: entry.description,
    hook: entry.hook,
    shell: entry.shell,
    filter: entry.filter,
    when: entry.when,
    default: existingDefault === true ? true : undefined,
  });

  writeSectionedFile(path, current);
  return true;
}

/**
 * Set the `default` flag of a single assert in the on-disk file.
 *
 * Writes the file in place (path can be project or global; the caller
 * picks the right one via the source-map cache).  When `value` is
 * `true` the entry gains a `"default": true` key; when `value` is
 * `false` the key is **deleted** (cleaner than writing `false`, since
 * `false` is the schema default and matches the installer's
 * "omit when false" pattern).
 *
 * Throws when the file does not exist, the section is missing, or the
 * assert entry is missing — these are bugs or stale external edits
 * that the UI surfaces via a notification.
 */
export function setAssertDefault(
  path: string,
  source: string,
  name: string,
  value: boolean,
): void {
  const current = readProjectFileAt(path);

  const section = current[source] as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object" || !(name in section)) {
    throw new Error(
      `assert "${name}" not found in section "${source}" of ${path}`,
    );
  }

  const entry = section[name];
  if (typeof entry !== "object" || entry === null) {
    throw new Error(
      `assert "${name}" in section "${source}" of ${path} is not an object`,
    );
  }
  const obj = entry as Record<string, unknown>;

  if (value) {
    obj.default = true;
  } else {
    delete obj.default;
  }

  writeSectionedFile(path, current);
}

/**
 * Return the list of repos declared in the config.
 * These are the repos the user has configured for installing asserts.
 */
export function getInstalledRepos(cwd: string): string[] {
  const current = readProjectFile(cwd);
  return current.repos ?? [];
}

/**
 * Add a repo to the `repos` array in the project config.
 * No-op if the repo is already present.
 *
 * Validates the owner/repo format.
 */
export function addRepo(cwd: string, repo: string): void {
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`Invalid repo format: "${repo}". Expected owner/repo.`);
  }

  const current = readProjectFile(cwd);
  if (!current.repos) current.repos = [];
  if (current.repos.includes(repo)) return; // already present

  current.repos.push(repo);
  writeProjectFile(cwd, current);
}

// ---------------------------------------------------------------------------
// Wizard helpers (pure: no I/O, no UI calls)
// ---------------------------------------------------------------------------

/** Sentinel value for the "Add repo…" action item in the repo picker. */
export const REPO_ADD_ACTION = "__add__";

/**
 * Default repo always shown first in the repo picker (marked "(default)")
 * so it's a one-key pick and the initial selection. Overridable via the
 * `PI_ASSERT_DEFAULT_REPO` env var.
 */
export const DEFAULT_REPO =
  process.env.PI_ASSERT_DEFAULT_REPO ?? "meffmadd/pi-assert-rules";

/**
 * Build the items list for the repo picker.
 *
 * The default repo is always shown first (marked "(default)"), so it's the
 * initial selection and a one-key pick; other configured repos follow in
 * their declared order, then a trailing "Add repo…" action item. If the
 * default repo is also in `repos`, it appears once (at the top).
 */
export function buildRepoPickerItems(repos: string[]): SelectItem[] {
  const items: SelectItem[] = [
    { value: DEFAULT_REPO, label: `${DEFAULT_REPO} (default)` },
  ];
  const seen = new Set([DEFAULT_REPO]);
  for (const r of repos) {
    if (seen.has(r)) continue;
    items.push({ value: r, label: r });
    seen.add(r);
  }
  items.push({ value: REPO_ADD_ACTION, label: "Add repo…" });
  return items;
}
