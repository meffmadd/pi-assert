import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

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

/** A file listed by the GitHub contents API. */
export interface RuleFile {
  /** Filename without .json extension (e.g. "defaults"). */
  name: string;
  /** Full path within the repo (e.g. "rules/defaults.json"). */
  path: string;
  /** Git blob SHA (for future version tracking). */
  sha: string;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

const API_BASE = "https://api.github.com";

/**
 * List `.json` files under `rules/` in a GitHub repo.
 *
 * Returns only regular files ending in `.json` (directories and other
 * file types are filtered out).  The `name` field has the `.json` extension
 * stripped (e.g. "defaults").
 */
export async function fetchRuleFiles(
  repo: string,
  ref = "main",
): Promise<RuleFile[]> {
  const url = `${API_BASE}/repos/${repo}/contents/rules?ref=${ref}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${url}`);
  }

  const items = (await res.json()) as Array<{
    name: string;
    path: string;
    sha: string;
    type: string;
  }>;

  return items
    .filter(
      (item) => item.type === "file" && item.name.endsWith(".json"),
    )
    .map((item) => ({
      name: item.name.replace(/\.json$/, ""),
      path: item.path,
      sha: item.sha,
    }));
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
  const url = `${API_BASE}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`;
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

function readFile(cwd: string): SectionedFile {
  const projectPath = join(cwd, ".pi", "asserts.json");

  if (!existsSync(projectPath)) return {};

  const raw = readFileSync(projectPath, "utf-8");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as SectionedFile;
  } catch {
    return {};
  }
}

function writeFile(cwd: string, data: SectionedFile): void {
  const projectPath = join(cwd, ".pi", "asserts.json");
  const dir = dirname(projectPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(projectPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

/**
 * Install a single assert into the project's `.pi/asserts.json`
 * under the given `repo` key (e.g. "meffmadd/pi-assert-rules").
 *
 * Strips the `description` field — only schema-valid fields are persisted.
 */
export function installRule(
  cwd: string,
  repo: string,
  name: string,
  entry: RuleEntry,
): void {
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

  // Warn if overwriting
  if (section[name] !== undefined) {
    console.warn(
      `pi-assert: overwriting existing assert "${name}" in "${repo}"`,
    );
  }

  section[name] = clean;
  writeFile(cwd, current);
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
