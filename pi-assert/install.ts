import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in a rules/*.json file from the pi-assert-rules repo. */
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

/**
 * Fetch the list of .json files from the `rules/` directory of a GitHub repo
 * via the unauthenticated contents API.
 */
export async function fetchRuleFiles(repo: string): Promise<RuleFile[]> {
  const url = `https://api.github.com/repos/${repo}/contents/rules`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub API error fetching rules list: ${res.status} ${res.statusText}`,
    );
  }

  const data = (await res.json()) as GitHubContentItem[];
  return data
    .filter((item) => item.type === "file" && item.name.endsWith(".json"))
    .map((item) => ({
      name: item.name.replace(/\.json$/, ""),
      path: item.path,
      sha: item.sha,
    }));
}

interface GitHubContentItem {
  type: string;
  name: string;
  path: string;
  sha: string;
}

/**
 * Fetch and parse a single rules/*.json file from a GitHub repo.
 * Returns a map of assert name → definition (with `description` field).
 */
export async function fetchRuleFile(
  repo: string,
  path: string,
): Promise<RuleEntries> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub API error fetching rule file: ${res.status} ${res.statusText}`,
    );
  }

  const item = (await res.json()) as GitHubFileItem;
  if (item.type !== "file" || !item.content) {
    throw new Error(`Not a file: ${path}`);
  }

  const raw = Buffer.from(item.content, "base64").toString("utf-8");
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Rule file ${path} is not a JSON object`);
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
// Local install
// ---------------------------------------------------------------------------

/**
 * Install a single assert into the project's `.pi/asserts.json`.
 *
 * Strips the `description` field before writing — only schema-valid fields
 * (`hook`, `shell`, `filter`, `when`, `default`) are persisted.
 * Creates the `.pi/` directory if it doesn't exist.
 */
export function installRule(
  cwd: string,
  name: string,
  entry: RuleEntry,
): void {
  const projectPath = join(cwd, ".pi", "asserts.json");

  // Read existing file (or start fresh)
  let current: Record<string, unknown> = {};
  if (existsSync(projectPath)) {
    const raw = readFileSync(projectPath, "utf-8");
    try {
      current = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // If the existing file is broken, start fresh but warn
      current = {};
    }
  }

  // Build the clean assert definition (no `description`)
  const clean: Record<string, unknown> = {
    hook: entry.hook,
    shell: entry.shell,
  };
  if (entry.filter !== undefined) clean.filter = entry.filter;
  if (entry.when !== undefined) clean.when = entry.when;
  if (entry.default !== undefined) clean.default = entry.default;

  current[name] = clean;

  // Ensure .pi/ directory exists
  const dir = dirname(projectPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(projectPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
}
