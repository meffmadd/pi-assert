import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { SelectItem } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in a rules/*.json file from a pi-assert-rules repo. */
export interface RuleEntry {
  /** Human-readable description shown in the install TUI. Stripped on install. */
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
 * Returns only entries that have a `description`, `hook`, and `shell`.
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
    if (!isValidRuleEntry(def)) continue;
    entries[name] = def;
  }

  return entries;
}

interface GitHubFileItem {
  type: string;
  content?: string;
  encoding?: string;
}

function isValidRuleEntry(def: unknown): def is RuleEntry {
  if (typeof def !== "object" || def === null) return false;
  const d = def as Record<string, unknown>;
  return (
    typeof d.description === "string" &&
    typeof d.hook === "string" &&
    typeof d.shell === "string"
  );
}

// ---------------------------------------------------------------------------
// Structured file I/O (sectioned format)
// ---------------------------------------------------------------------------

/** Shape of the sectioned .pi/asserts.json file. */
interface SectionedFile {
  $schema?: string;
  repos?: string[];
  local?: Record<string, unknown>;
  [repo: string]: unknown;
}

/** Resolve the project .pi/asserts.json path for a given cwd. */
function projectFilePath(cwd: string): string {
  return join(cwd, ".pi", "asserts.json");
}

/**
 * Path-based read of a sectioned asserts file.  Returns `{}` when the
 * file is missing or unparseable (the latter matches the historical
 * behaviour of the cwd-based helper and keeps install/remove
 * best-effort).  Used by the cwd-based `readFile` and by
 * `setAssertDefault` when the caller already knows the absolute path.
 */
function readSectionedFile(path: string): SectionedFile {
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, "utf-8");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as SectionedFile;
  } catch {
    return {};
  }
}

/** Path-based write of a sectioned asserts file.  Creates parent dirs. */
function writeSectionedFile(path: string, data: SectionedFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function readFile(cwd: string): SectionedFile {
  return readSectionedFile(projectFilePath(cwd));
}

function writeFile(cwd: string, data: SectionedFile): void {
  writeSectionedFile(projectFilePath(cwd), data);
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

/**
 * Install a single assert into the project's `.pi/asserts.json`
 * under the given `repo` key (e.g. "meffmadd/pi-assert-rules").
 *
 * Strips the `description` field — only schema-valid fields are persisted.
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
  const current = readFile(cwd);

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

  // Build the clean assert definition (no `description`)
  const clean: Record<string, unknown> = {
    hook: entry.hook,
    shell: entry.shell,
  };
  if (entry.filter !== undefined) clean.filter = entry.filter;
  if (entry.when !== undefined) clean.when = entry.when;
  if (entry.default !== undefined) clean.default = entry.default;

  // Warn if overwriting — surfaced by callers via a TUI notification
  // (console.warn is invisible in the TUI).
  const overwritten = section[name] !== undefined;

  section[name] = clean;
  writeFile(cwd, current);
  return overwritten;
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
  const current = readFile(cwd);

  const section = current[repo] as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object" || !(name in section)) {
    return false;
  }

  delete section[name];

  // Prune empty section
  if (Object.keys(section).length === 0) {
    delete current[repo];
  }

  writeFile(cwd, current);
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
  const current = readSectionedFile(path);

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
  const current = readFile(cwd);
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

  const current = readFile(cwd);
  if (!current.repos) current.repos = [];
  if (current.repos.includes(repo)) return; // already present

  current.repos.push(repo);
  writeFile(cwd, current);
}

// ---------------------------------------------------------------------------
// Wizard helpers (pure: no I/O, no UI calls)
// ---------------------------------------------------------------------------

/** Sentinel value for the "Add repo…" action item in the repo picker. */
export const REPO_ADD_ACTION = "__add__";

/** Default repo suggested when adding a repo with none configured. */
export const DEFAULT_REPO =
  process.env.PI_ASSERT_DEFAULT_REPO ?? "meffmadd/pi-assert-rules";

/**
 * Build the items list for the repo picker.
 * Lists existing repos first, then a trailing "Add repo…" action item.
 */
export function buildRepoPickerItems(repos: string[]): SelectItem[] {
  return [
    ...repos.map((r) => ({ value: r, label: r })),
    { value: REPO_ADD_ACTION, label: "Add repo…" },
  ];
}
