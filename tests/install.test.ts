/**
 * Tests for install.ts — GitHub API fetching & local rule installation.
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  fetchRuleFiles,
  fetchRuleFile,
  fetchRepoEntries,
  clearRepoEntriesCache,
  installRule,
  updateRule,
  removeRule,
  addRepo,
  getInstalledRepos,
  setAssertDefault,
  buildRepoPickerItems,
  REPO_ADD_ACTION,
  DEFAULT_REPO,
  type RuleEntries,
  type RuleFile,
  type RuleEntry,
} from "../pi-assert/installer.js";

// ── Helpers ───────────────────────────────────────────────────────

let tmpRoot: string;

before(() => {
  tmpRoot = join(tmpdir(), `pi-assert-install-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a minimal mock fetch Response with given JSON body and status. */
function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status === 403 ? "Forbidden" : "OK",
    json: async () => body,
  } as Response;
}

/**
 * Base64-encode a JSON-serialisable value, returning an object shaped
 * like the GitHub individual file endpoint response.
 */
function mockFileResponse(
  name: string,
  path: string,
  content: unknown,
): unknown {
  const json = JSON.stringify(content);
  const b64 = Buffer.from(json).toString("base64");
  return {
    name,
    path,
    sha: "abc123",
    size: json.length,
    type: "file",
    content: b64,
    encoding: "base64",
  };
}

/** Real API response shape for a Git Trees API blob entry. */
function mockTreeBlob(path: string, sha = "abc123"): unknown {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha,
    size: 100,
    url: `https://api.github.com/repos/meffmadd/pi-assert-rules/git/blobs/${sha}`,
  };
}

/** Real API response shape for a Git Trees API tree (directory) entry. */
function mockTreeDir(path: string, sha = "dir-sha"): unknown {
  return {
    path,
    mode: "040000",
    type: "tree",
    sha,
    url: `https://api.github.com/repos/meffmadd/pi-assert-rules/git/trees/${sha}`,
  };
}

/**
 * Mock `globalThis.fetch` to serve a single recursive-trees response.
 * `fetchRuleFiles` now does one call (branch name passed directly as
 * the tree SHA), so routing is by URL substring.
 */
function mockTreesFetch(
  tree: unknown[],
  opts: {
    truncated?: boolean;
    status?: number;
  } = {},
): void {
  mock.method(globalThis, "fetch", (url: string) => {
    if (url.includes("/git/trees/")) {
      if (opts.status) return mockJsonResponse({}, opts.status);
      return mockJsonResponse({
        sha: "tree-sha",
        url,
        tree,
        truncated: opts.truncated ?? false,
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

// ═══════════════════════════════════════════════════════════════════
// fetchRuleFiles
// ═══════════════════════════════════════════════════════════════════

describe("fetchRuleFiles", () => {
  type PassCase = { label: string; tree: unknown[]; expected: RuleFile[] };

  const passCases: PassCase[] = [
    {
      label: "returns only .json blobs under rules/ and strips rules/ prefix + .json",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("rules/security.json"),
      ],
      expected: [
        { name: "defaults", path: "rules/defaults.json", sha: "abc123" },
        { name: "security", path: "rules/security.json", sha: "abc123" },
      ],
    },
    {
      label: "filters out non-.json files under rules/",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("rules/README.md"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "filters out tree (directory) entries",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeDir("rules/subdir"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "filters out files outside rules/ (tree is repo-wide)",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("README.md"),
        mockTreeBlob("src/index.ts"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "returns [] for empty tree",
      tree: [],
      expected: [],
    },
    {
      label: "nested subdirectories: strips rules/ prefix, preserves intermediate dirs in name",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("rules/security/writes.json"),
        mockTreeBlob("rules/security/reads.json"),
        mockTreeBlob("rules/git/no-force-push.json"),
        mockTreeBlob("rules/experimental/drafts/trial.json"),
        // dir entries and non-rules files are present too, to confirm they're dropped
        mockTreeDir("rules/security"),
        mockTreeDir("rules/git"),
        mockTreeBlob("package.json"),
      ],
      expected: [
        { name: "defaults", path: "rules/defaults.json", sha: "abc123" },
        { name: "experimental/drafts/trial", path: "rules/experimental/drafts/trial.json", sha: "abc123" },
        { name: "git/no-force-push", path: "rules/git/no-force-push.json", sha: "abc123" },
        { name: "security/reads", path: "rules/security/reads.json", sha: "abc123" },
        { name: "security/writes", path: "rules/security/writes.json", sha: "abc123" },
      ],
    },
  ];

  for (const { label, tree, expected } of passCases) {
    it(label, async () => {
      mockTreesFetch(tree);
      assert.deepStrictEqual(
        await fetchRuleFiles("meffmadd/pi-assert-rules"),
        expected,
      );
    });
  }

  // ── Throws cases ────────────────────────────────────────────────

  type ThrowsCase = {
    label: string;
    tree?: unknown[];
    status?: number;
    truncated?: boolean;
    errorPattern: RegExp;
  };

  const throwsCases: ThrowsCase[] = [
    {
      label: "throws on 404 from trees",
      tree: [],
      status: 404,
      errorPattern: /404/,
    },
    {
      label: "throws when tree is truncated (too many entries)",
      tree: [mockTreeBlob("rules/a.json")],
      truncated: true,
      errorPattern: /truncated/i,
    },
  ];

  for (const { label, tree, status, truncated, errorPattern } of throwsCases) {
    it(label, async () => {
      mockTreesFetch(tree ?? [], { status, truncated });
      await assert.rejects(
        () => fetchRuleFiles("meffmadd/pi-assert-rules"),
        errorPattern,
      );
    });
  }

  // ── Network error (mock throws instead of returning a response) ─

  it("throws on network error", async () => {
    mock.method(globalThis, "fetch", () => {
      throw new Error("connect ECONNREFUSED");
    });
    await assert.rejects(
      () => fetchRuleFiles("meffmadd/pi-assert-rules"),
      /ECONNREFUSED/,
    );
  });

  // ── URL shape & ref normalisation ───────────────────────────────

  it("calls git/trees/{branch}?recursive=1 directly (no ref-resolve hop)", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse({ tree: [], truncated: false });
    });
    await fetchRuleFiles("meffmadd/pi-assert-rules", "develop");
    assert.strictEqual(calls.length, 1, "exactly one fetch call");
    assert.match(calls[0]!, /\/git\/trees\/develop\?recursive=1$/, calls[0]!);
  });

  it("strips a refs/heads/ prefix from the ref before calling git/trees/", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse({ tree: [], truncated: false });
    });
    await fetchRuleFiles("meffmadd/pi-assert-rules", "refs/heads/main");
    assert.match(calls[0]!, /\/git\/trees\/main\?recursive=1$/, calls[0]!);
    assert.doesNotMatch(calls[0]!, /refs\/heads\/refs\/heads/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// fetchRuleFile
// ═══════════════════════════════════════════════════════════════════

describe("fetchRuleFile", () => {
  type PassCase = { label: string; content: unknown; expected: RuleEntries };

  const passCases: PassCase[] = [
    {
      label: "parses a valid rules file with multiple entries",
      content: {
        "block-write": {
          description: "Blocks all write calls.",
          hook: "tool_call",
          filter: { toolName: "write" },
          shell: "false",
        },
        "no-rm-rf": {
          description: "Blocks rm -rf in bash.",
          hook: "tool_call",
          shell: "grep rm",
        },
      },
      expected: {
        "block-write": {
          description: "Blocks all write calls.",
          hook: "tool_call",
          filter: { toolName: "write" },
          shell: "false",
        },
        "no-rm-rf": {
          description: "Blocks rm -rf in bash.",
          hook: "tool_call",
          shell: "grep rm",
        },
      },
    },
    {
      label: "skips entries missing description",
      content: {
        valid: { description: "Valid entry.", hook: "tool_call", shell: "true" },
        "no-desc": { hook: "tool_call", shell: "false" },
      },
      expected: {
        valid: { description: "Valid entry.", hook: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips entries missing hook",
      content: {
        "no-hook": { description: "Missing hook.", shell: "false" },
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips entries missing shell",
      content: {
        "no-shell": { description: "Missing shell.", hook: "tool_call" },
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips non-object entries (null, string)",
      content: {
        nil: null,
        str: "just a string",
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
    },
  ];

  for (const { label, content, expected } of passCases) {
    it(label, async () => {
      mock.method(globalThis, "fetch", () =>
        mockJsonResponse(
          mockFileResponse("defaults.json", "rules/defaults.json", content),
        ),
      );
      assert.deepStrictEqual(
        await fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
        expected,
      );
    });
  }

  // ── Nested-path & URL encoding (per-segment, slashes preserved) ─

  it("fetches a nested path with per-segment URL encoding (slashes preserved)", async () => {
    const calls: string[] = [];
    const content = { x: { description: "d", hook: "tool_call", shell: "true" } };
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse(
        mockFileResponse("writes.json", "rules/security/writes.json", content),
      );
    });
    const result = await fetchRuleFile(
      "meffmadd/pi-assert-rules",
      "rules/security/writes.json",
    );
    assert.ok(calls[0], "fetch was called");
    // Slashes must be preserved in the contents path.
    assert.match(calls[0]!, /\/contents\/rules\/security\/writes\.json/, calls[0]!);
    assert.doesNotMatch(calls[0]!, /%2F/, `slash must not be encoded: ${calls[0]}`);
    assert.deepStrictEqual(result, content);
  });

  it("encodes special characters within a single path segment", async () => {
    const calls: string[] = [];
    const content = { x: { description: "d", hook: "tool_call", shell: "true" } };
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse(
        mockFileResponse("my rules.json", "rules/my rules/x.json", content),
      );
    });
    await fetchRuleFile("meffmadd/pi-assert-rules", "rules/my rules/x.json");
    // Space within a segment is encoded, slashes between segments are not.
    assert.match(calls[0]!, /\/contents\/rules\/my%20rules\/x\.json/, calls[0]!);
  });

  // ── Throws cases ────────────────────────────────────────────────

  type ThrowsCase = { label: string; response: unknown; errorPattern: RegExp };

  const throwsCases: ThrowsCase[] = [
    {
      label: "throws when response has no content (not a file)",
      response: mockJsonResponse({ type: "dir", name: "rules", path: "rules" }),
      errorPattern: /Not a file/,
    },
    {
      label: "throws on non-JSON content",
      response: mockJsonResponse({
        type: "file",
        name: "defaults.json",
        path: "rules/defaults.json",
        content: Buffer.from("not valid json!!!").toString("base64"),
        encoding: "base64",
      }),
      errorPattern: /JSON/,
    },
    {
      label: "throws when content is a JSON array",
      response: mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", [1, 2, 3]),
      ),
      errorPattern: /not a JSON object/,
    },
    {
      label: "throws on HTTP error",
      response: mockJsonResponse({}, 500),
      errorPattern: /500/,
    },
  ];

  for (const { label, response, errorPattern } of throwsCases) {
    it(label, async () => {
      mock.method(globalThis, "fetch", () => response as Response);
      await assert.rejects(
        () => fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
        errorPattern,
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// fetchRepoEntries
// ═══════════════════════════════════════════════════════════════════

describe("fetchRepoEntries", () => {
  // Each test gets a fresh cache so cached results don't bleed across tests.
  before(() => clearRepoEntriesCache());
  after(() => clearRepoEntriesCache());

  /**
   * Mock `fetch` so the trees call returns the given blob paths, and each
   * contents call returns the given file contents (keyed by path).
   */
  function mockMultiFileFetch(
    treeBlobs: string[],
    fileContents: Record<string, unknown>,
  ): void {
    mock.method(globalThis, "fetch", (url: string) => {
      if (url.includes("/git/trees/")) {
        return mockJsonResponse({
          sha: "tree-sha",
          url,
          tree: treeBlobs.map((p) => mockTreeBlob(p)),
          truncated: false,
        });
      }
      // contents call — match by the encoded path in the URL.
      for (const [path, content] of Object.entries(fileContents)) {
        if (url.includes(path.split("/").map(encodeURIComponent).join("/"))) {
          return mockJsonResponse(
            mockFileResponse(path.split("/").pop()!, path, content),
          );
        }
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
  }

  it("flattens all entries from all files into a name→entry map", async () => {
    clearRepoEntriesCache();
    mockMultiFileFetch(
      ["rules/defaults.json", "rules/security/writes.json"],
      {
        "rules/defaults.json": {
          "rule-a": { description: "A.", hook: "tool_call", shell: "false" },
          "rule-b": { description: "B.", hook: "tool_call", shell: "true" },
        },
        "rules/security/writes.json": {
          "block-write": {
            description: "Blocks writes.",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
    );

    const result = await fetchRepoEntries("some/repo");
    assert.strictEqual(result.size, 3);
    assert.deepStrictEqual(result.get("rule-a"), {
      description: "A.",
      hook: "tool_call",
      shell: "false",
    });
    assert.deepStrictEqual(result.get("block-write"), {
      description: "Blocks writes.",
      hook: "tool_call",
      filter: { toolName: "write" },
      shell: "false",
    });
  });

  it("returns an empty map for a repo with no rule files", async () => {
    clearRepoEntriesCache();
    mockTreesFetch([]);
    const result = await fetchRepoEntries("empty/repo");
    assert.strictEqual(result.size, 0);
  });

  it("caches the result across calls (one fetch round per repo@ref)", async () => {
    clearRepoEntriesCache();
    let callCount = 0;
    mock.method(globalThis, "fetch", (url: string) => {
      callCount++;
      if (url.includes("/git/trees/")) {
        return mockJsonResponse({ tree: [], truncated: false });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    await fetchRepoEntries("cached/repo");
    const firstRoundCalls = callCount;
    await fetchRepoEntries("cached/repo"); // should hit cache
    assert.strictEqual(callCount, firstRoundCalls, "second call makes no fetches");
  });

  it("does NOT cache failures (retryable on the next call)", async () => {
    clearRepoEntriesCache();
    let callCount = 0;
    mock.method(globalThis, "fetch", () => {
      callCount++;
      throw new Error("connect ECONNREFUSED");
    });

    await assert.rejects(() => fetchRepoEntries("fail/repo"), /ECONNREFUSED/);
    await assert.rejects(() => fetchRepoEntries("fail/repo"), /ECONNREFUSED/);
    assert.ok(callCount > 1, "second call re-fetched (failure was not cached)");
  });

  it("skips invalid entries (missing description/hook/shell)", async () => {
    clearRepoEntriesCache();
    mockMultiFileFetch(["rules/defaults.json"], {
      "rules/defaults.json": {
        valid: { description: "V.", hook: "tool_call", shell: "true" },
        "no-desc": { hook: "tool_call", shell: "false" },
        "no-shell": { description: "D.", hook: "tool_call" },
        nil: null,
      },
    });
    const result = await fetchRepoEntries("mixed/repo");
    assert.deepStrictEqual([...result.keys()], ["valid"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// installRule
// ═══════════════════════════════════════════════════════════════════

describe("installRule", () => {
  type Case = {
    label: string;
    initialJson: object | undefined;
    repo: string;
    name: string;
    entry: RuleEntry;
    expected: object;
  };

  const cases: Case[] = [
    // ── Fresh installs ────────────────────────────────────────────
    {
      label: "writes to fresh .pi/asserts.json under correct repo key",
      initialJson: undefined,
      repo: "meffmadd/pi-assert-rules",
      name: "my-rule",
      entry: { description: "A test rule.", hook: "tool_call", shell: "false" },
      expected: {
        "meffmadd/pi-assert-rules": { "my-rule": { description: "A test rule.", hook: "tool_call", shell: "false" } },
        repos: ["meffmadd/pi-assert-rules"],
      },
    },
    {
      label: "keeps description in written output",
      initialJson: undefined,
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "This should appear.", hook: "tool_call", shell: "false" },
      expected: {
        "some/repo": { "my-rule": { description: "This should appear.", hook: "tool_call", shell: "false" } },
        repos: ["some/repo"],
      },
    },
    {
      label: "writes filter when present",
      initialJson: undefined,
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "Test.", hook: "tool_call", filter: { toolName: "write" }, shell: "false" },
      expected: {
        "some/repo": { "my-rule": { description: "Test.", hook: "tool_call", filter: { toolName: "write" }, shell: "false" } },
        repos: ["some/repo"],
      },
    },
    {
      label: "writes when when present",
      initialJson: undefined,
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "Test.", hook: "tool_call", when: "git diff --quiet", shell: "false" },
      expected: {
        "some/repo": { "my-rule": { description: "Test.", hook: "tool_call", when: "git diff --quiet", shell: "false" } },
        repos: ["some/repo"],
      },
    },
    {
      label: "writes default when present",
      initialJson: undefined,
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "Test.", hook: "tool_call", shell: "false", default: true },
      expected: {
        "some/repo": { "my-rule": { description: "Test.", hook: "tool_call", shell: "false", default: true } },
        repos: ["some/repo"],
      },
    },
    {
      label: "omits optional fields when absent",
      initialJson: undefined,
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "Test.", hook: "tool_call", shell: "false" },
      expected: {
        "some/repo": { "my-rule": { description: "Test.", hook: "tool_call", shell: "false" } },
        repos: ["some/repo"],
      },
    },
    {
      label: "writes all optional fields when all present",
      initialJson: undefined,
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "Test.", hook: "tool_call", filter: { toolName: "bash" }, when: "true", shell: "false", default: true },
      expected: {
        "some/repo": {
          "my-rule": { description: "Test.", hook: "tool_call", filter: { toolName: "bash" }, when: "true", shell: "false", default: true },
        },
        repos: ["some/repo"],
      },
    },

    // ── Merging / overwriting existing files ──────────────────────
    {
      label: "merges into existing file (preserves other sections)",
      initialJson: { local: { existing: { hook: "tool_call", shell: "true" } } },
      repo: "meffmadd/pi-assert-rules",
      name: "new-rule",
      entry: { description: "New rule.", hook: "tool_call", filter: { toolName: "bash" }, shell: "false" },
      expected: {
        local: { existing: { hook: "tool_call", shell: "true" } },
        "meffmadd/pi-assert-rules": { "new-rule": { description: "New rule.", hook: "tool_call", filter: { toolName: "bash" }, shell: "false" } },
        repos: ["meffmadd/pi-assert-rules"],
      },
    },
    {
      label: "overwrites existing key with same name in same repo",
      initialJson: { "meffmadd/pi-assert-rules": { "my-rule": { hook: "tool_call", shell: "old" } } },
      repo: "meffmadd/pi-assert-rules",
      name: "my-rule",
      entry: { description: "Updated.", hook: "tool_call", shell: "new" },
      expected: {
        "meffmadd/pi-assert-rules": { "my-rule": { description: "Updated.", hook: "tool_call", shell: "new" } },
        repos: ["meffmadd/pi-assert-rules"],
      },
    },
    {
      label: "handles broken existing JSON (starts fresh)",
      initialJson: undefined, // file content is written manually below
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "Test.", hook: "tool_call", shell: "true" },
      expected: {
        "some/repo": { "my-rule": { description: "Test.", hook: "tool_call", shell: "true" } },
        repos: ["some/repo"],
      },
    },
    {
      label: "installs into a second repo without clobbering the first",
      initialJson: undefined, // first install is done separately, second via installRule
      repo: "repo/b",
      name: "rule2",
      entry: { description: "Second.", hook: "tool_call", shell: "false" },
      expected: {
        "repo/a": { rule1: { description: "First.", hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { description: "Second.", hook: "tool_call", shell: "false" } },
        repos: ["repo/a", "repo/b"],
      },
    },
    {
      label: "repos not duplicated when installing to already-declared repo",
      initialJson: { repos: ["meffmadd/pi-assert-rules"] },
      repo: "meffmadd/pi-assert-rules",
      name: "my-rule",
      entry: { description: "A rule.", hook: "tool_call", shell: "false" },
      expected: {
        repos: ["meffmadd/pi-assert-rules"],
        "meffmadd/pi-assert-rules": { "my-rule": { description: "A rule.", hook: "tool_call", shell: "false" } },
      },
    },
  ];

  for (const { label, initialJson, repo, name, entry, expected } of cases) {
    it(label, () => {
      const cwd = join(tmpRoot, label.replace(/[^a-z0-9-]/gi, "-"));

      // Special setup for some tests
      if (label === "handles broken existing JSON (starts fresh)") {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), "{not valid json!!!");
      } else if (label === "installs into a second repo without clobbering the first") {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        installRule(cwd, "repo/a", "rule1", { description: "First.", hook: "tool_call", shell: "true" });
      } else if (initialJson !== undefined) {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), JSON.stringify(initialJson));
      } else {
        mkdirSync(cwd, { recursive: true });
      }

      if (label === "handles broken existing JSON (starts fresh)") {
        assert.throws(() => installRule(cwd, repo, name, entry));
        assert.equal(readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8"), "{not valid json!!!");
        return;
      }
      installRule(cwd, repo, name, entry);

      const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, expected);
    });
  }

  // ── Standalone: directory creation check ────────────────────────

  it("creates .pi/ directory if missing", () => {
    const cwd = join(tmpRoot, "no-pi-dir");
    mkdirSync(cwd, { recursive: true });
    assert.strictEqual(existsSync(join(cwd, ".pi")), false);

    installRule(cwd, "some/repo", "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "true",
    });

    assert.strictEqual(existsSync(join(cwd, ".pi")), true);
    assert.strictEqual(existsSync(join(cwd, ".pi", "asserts.json")), true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// removeRule
// ═══════════════════════════════════════════════════════════════════

describe("removeRule", () => {
  type Case = {
    label: string;
    initialJson: object | undefined;
    repo: string;
    name: string;
    expectedResult: boolean;
    expectedParsed?: object;
  };

  const cases: Case[] = [
    {
      label: "removes an existing assert from a repo section",
      initialJson: {
        local: { "keep-me": { hook: "tool_call", shell: "true" } },
        "some/repo": { "drop-me": { hook: "tool_call", shell: "false" } },
      },
      repo: "some/repo",
      name: "drop-me",
      expectedResult: true,
      expectedParsed: { local: { "keep-me": { hook: "tool_call", shell: "true" } } },
    },
    {
      label: "prunes empty repo section",
      initialJson: {
        "some/repo": { "only-me": { hook: "tool_call", shell: "true" } },
      },
      repo: "some/repo",
      name: "only-me",
      expectedResult: true,
      expectedParsed: {},
    },
    {
      label: "returns false when assert not found",
      initialJson: {
        "some/repo": { "my-rule": { hook: "tool_call", shell: "true" } },
      },
      repo: "some/repo",
      name: "nonexistent",
      expectedResult: false,
    },
    {
      label: "returns false when repo section missing",
      initialJson: {
        local: { "my-rule": { hook: "tool_call", shell: "true" } },
      },
      repo: "other/repo",
      name: "anything",
      expectedResult: false,
    },
    {
      label: "returns false when file missing",
      initialJson: undefined,
      repo: "any/repo",
      name: "anything",
      expectedResult: false,
    },
    {
      label: "returns false on broken JSON",
      initialJson: undefined, // handled manually
      repo: "any/repo",
      name: "anything",
      expectedResult: false,
    },
  ];

  for (const { label, initialJson, repo, name, expectedResult, expectedParsed } of cases) {
    it(label, () => {
      const cwd = join(tmpRoot, `remove-${label.replace(/[^a-z0-9-]/gi, "-")}`);

      if (label === "returns false on broken JSON") {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), "not json!!!");
      } else if (label === "returns false when file missing") {
        // don't create anything
      } else if (initialJson !== undefined) {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), JSON.stringify(initialJson));
      }

      if (label === "returns false on broken JSON") {
        assert.throws(() => removeRule(cwd, repo, name));
        assert.equal(readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8"), "not json!!!");
        return;
      }
      const result = removeRule(cwd, repo, name);
      assert.strictEqual(result, expectedResult);

      if (expectedParsed !== undefined) {
        const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
        const parsed = JSON.parse(raw);
        assert.deepStrictEqual(parsed, expectedParsed);
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// updateRule
// ═══════════════════════════════════════════════════════════════════

describe("updateRule", () => {
  type Case = {
    label: string;
    initialJson: object;
    path: (cwd: string) => string;
    source: string;
    name: string;
    entry: RuleEntry;
    expected: object;
    expectedResult: boolean;
  };

  const cases: Case[] = [
    {
      label: "updates shell content to match the repo entry",
      initialJson: {
        "some/repo": {
          "my-rule": { description: "Old desc.", hook: "tool_call", shell: "old" },
        },
      },
      path: (cwd) => join(cwd, ".pi", "asserts.json"),
      source: "some/repo",
      name: "my-rule",
      entry: { description: "New desc.", hook: "tool_call", shell: "new" },
      expected: {
        "some/repo": {
          "my-rule": { description: "New desc.", hook: "tool_call", shell: "new" },
        },
      },
      expectedResult: true,
    },
    {
      label: "preserves the on-disk default:true (ignores repo default)",
      initialJson: {
        "some/repo": {
          "my-rule": {
            description: "Old.",
            hook: "tool_call",
            shell: "old",
            default: true,
          },
        },
      },
      path: (cwd) => join(cwd, ".pi", "asserts.json"),
      source: "some/repo",
      name: "my-rule",
      entry: { description: "New.", hook: "tool_call", shell: "new" },
      expected: {
        "some/repo": {
          "my-rule": {
            description: "New.",
            hook: "tool_call",
            shell: "new",
            default: true,
          },
        },
      },
      expectedResult: true,
    },
    {
      label: "preserves absent default when repo entry has default:true",
      initialJson: {
        "some/repo": {
          "my-rule": { description: "Old.", hook: "tool_call", shell: "old" },
        },
      },
      path: (cwd) => join(cwd, ".pi", "asserts.json"),
      source: "some/repo",
      name: "my-rule",
      entry: { description: "New.", hook: "tool_call", shell: "new", default: true },
      expected: {
        "some/repo": {
          // default must NOT appear — the installed entry had none.
          "my-rule": { description: "New.", hook: "tool_call", shell: "new" },
        },
      },
      expectedResult: true,
    },
    {
      label: "writes to the given path (not always the project file)",
      initialJson: {
        "some/repo": {
          "my-rule": { description: "Old.", hook: "tool_call", shell: "old" },
        },
      },
      path: (cwd) => join(cwd, "custom", "asserts.json"),
      source: "some/repo",
      name: "my-rule",
      entry: { description: "New.", hook: "tool_call", shell: "new" },
      expected: {
        "some/repo": {
          "my-rule": { description: "New.", hook: "tool_call", shell: "new" },
        },
      },
      expectedResult: true,
    },
    {
      label: "updates filter and when fields",
      initialJson: {
        "some/repo": {
          "my-rule": { description: "Old.", hook: "tool_call", shell: "old" },
        },
      },
      path: (cwd) => join(cwd, ".pi", "asserts.json"),
      source: "some/repo",
      name: "my-rule",
      entry: {
        description: "New.",
        hook: "tool_call",
        filter: { toolName: "bash" },
        when: "true",
        shell: "new",
      },
      expected: {
        "some/repo": {
          "my-rule": {
            description: "New.",
            hook: "tool_call",
            filter: { toolName: "bash" },
            when: "true",
            shell: "new",
          },
        },
      },
      expectedResult: true,
    },
    {
      label: "returns false when the section is missing",
      initialJson: { local: { rule: { hook: "tool_call", shell: "true" } } },
      path: (cwd) => join(cwd, ".pi", "asserts.json"),
      source: "absent/repo",
      name: "my-rule",
      entry: { description: "New.", hook: "tool_call", shell: "new" },
      expected: { local: { rule: { hook: "tool_call", shell: "true" } } },
      expectedResult: false,
    },
    {
      label: "returns false when the name is missing from the section",
      initialJson: {
        "some/repo": { "other-rule": { hook: "tool_call", shell: "true" } },
      },
      path: (cwd) => join(cwd, ".pi", "asserts.json"),
      source: "some/repo",
      name: "my-rule",
      entry: { description: "New.", hook: "tool_call", shell: "new" },
      expected: {
        "some/repo": { "other-rule": { hook: "tool_call", shell: "true" } },
      },
      expectedResult: false,
    },
  ];

  for (const { label, initialJson, path, source, name, entry, expected, expectedResult } of cases) {
    it(label, () => {
      const cwd = join(tmpRoot, `update-${label.replace(/[^a-z0-9-]/gi, "-")}`);
      const filePath = path(cwd);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, JSON.stringify(initialJson));

      const result = updateRule(filePath, source, name, entry);
      assert.strictEqual(result, expectedResult);

      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, expected);
    });
  }

  it("produces a clean record matching installRule's output shape", () => {
    const cwd = join(tmpRoot, "update-clean-shape");
    const filePath = join(cwd, ".pi", "asserts.json");
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        "some/repo": {
          "my-rule": { description: "Old.", hook: "tool_call", shell: "old" },
        },
      }),
    );

    const entry: RuleEntry = {
      description: "New.",
      hook: "tool_call",
      filter: { toolName: "bash" },
      when: "true",
      shell: "new",
    };
    updateRule(filePath, "some/repo", "my-rule", entry);

    // An install of the same entry should produce the same on-disk record
    // (minus the default-preservation difference, which doesn't apply here
    // since neither side has a default).
    const installCwd = join(tmpRoot, "update-clean-shape-install");
    installRule(installCwd, "some/repo", "my-rule", entry);

    const updated = JSON.parse(readFileSync(filePath, "utf-8"));
    const installed = JSON.parse(
      readFileSync(join(installCwd, ".pi", "asserts.json"), "utf-8"),
    );
    // Both should have the same record for "my-rule" under "some/repo".
    assert.deepStrictEqual(
      updated["some/repo"]["my-rule"],
      installed["some/repo"]["my-rule"],
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// getInstalledRepos
// ═══════════════════════════════════════════════════════════════════

describe("getInstalledRepos", () => {
  type Case = {
    label: string;
    initialJson: object | undefined;
    expected: string[];
  };

  const cases: Case[] = [
    {
      label: "returns repo keys (excluding local and $schema)",
      initialJson: {
        $schema: "https://example.com/schema.json",
        repos: ["meffmadd/pi-assert-rules", "other/repo"],
        local: { rule: { hook: "tool_call", shell: "true" } },
        "meffmadd/pi-assert-rules": { block: { hook: "tool_call", shell: "false" } },
        "other/repo": { another: { hook: "tool_call", shell: "true" } },
      },
      expected: ["meffmadd/pi-assert-rules", "other/repo"],
    },
    {
      label: "returns [] when no repo sections exist",
      initialJson: {
        local: { rule: { hook: "tool_call", shell: "true" } },
      },
      expected: [],
    },
    {
      label: "returns [] when file missing",
      initialJson: undefined,
      expected: [],
    },
  ];

  for (const { label, initialJson, expected } of cases) {
    it(label, () => {
      const cwd = join(tmpRoot, `repos-${label.replace(/[^a-z0-9-]/gi, "-")}`);

      if (label === "returns [] when file missing") {
        // don't create anything
      } else if (initialJson !== undefined) {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), JSON.stringify(initialJson));
      }

      const result = getInstalledRepos(cwd).sort();
      assert.deepStrictEqual(result, expected);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// addRepo
// ═══════════════════════════════════════════════════════════════════

describe("addRepo", () => {
  type Case = {
    label: string;
    initialJson: object | undefined;
    repo: string;
    expectedRepos: string[];
  };

  const cases: Case[] = [
    {
      label: "adds a repo to the repos array",
      initialJson: undefined,
      repo: "meffmadd/pi-assert-rules",
      expectedRepos: ["meffmadd/pi-assert-rules"],
    },
    {
      label: "appends to existing repos",
      initialJson: { repos: ["repo/a"], local: { rule: { hook: "tool_call", shell: "true" } } },
      repo: "repo/b",
      expectedRepos: ["repo/a", "repo/b"],
    },
    {
      label: "no-op when repo already present",
      initialJson: { repos: ["repo/a"], "repo/a": { rule: { hook: "tool_call", shell: "true" } } },
      repo: "repo/a",
      expectedRepos: ["repo/a"],
    },
    {
      label: "preserves local section when adding repo",
      initialJson: { local: { rule: { hook: "tool_call", shell: "true" } } },
      repo: "some/repo",
      expectedRepos: ["some/repo"],
    },
  ];

  for (const { label, initialJson, repo, expectedRepos } of cases) {
    it(label, () => {
      const cwd = join(tmpRoot, `add-${label.replace(/[^a-z0-9-]/gi, "-")}`);

      if (label === "no-op when repo already present") {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), JSON.stringify(initialJson));
        addRepo(cwd, repo);
        const repos = getInstalledRepos(cwd);
        assert.deepStrictEqual(repos, expectedRepos);
        // Verify file content unchanged (not rewritten) — still has original keys
        const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
        const parsed = JSON.parse(raw);
        assert.deepStrictEqual(parsed.repos, ["repo/a"]);
        assert.ok("repo/a" in parsed);
        assert.strictEqual(Object.keys(parsed).length, 2);
      } else if (label === "preserves local section when adding repo") {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), JSON.stringify(initialJson));
        addRepo(cwd, repo);
        const repos = getInstalledRepos(cwd);
        assert.deepStrictEqual(repos, expectedRepos);
        const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
        const parsed = JSON.parse(raw);
        assert.ok("local" in parsed);
      } else if (initialJson !== undefined) {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "asserts.json"), JSON.stringify(initialJson));
        addRepo(cwd, repo);
        assert.deepStrictEqual(getInstalledRepos(cwd), expectedRepos);
      } else {
        mkdirSync(cwd, { recursive: true });
        addRepo(cwd, repo);
        assert.deepStrictEqual(getInstalledRepos(cwd), expectedRepos);
      }
    });
  }

  // ── Standalone: throws on invalid repo format ───────────────────

  it("throws on invalid format (no slash)", () => {
    const cwd = join(tmpRoot, "add-repo-bad");
    mkdirSync(cwd, { recursive: true });
    assert.throws(() => addRepo(cwd, "not-a-repo"), /Invalid repo format/);
  });
});

// ── Wizard helpers (pure) ─────────────────────────────────────────

describe("REPO_ADD_ACTION", () => {
  it("is the sentinel string '__add__'", () => {
    assert.equal(REPO_ADD_ACTION, "__add__");
  });
});

describe("buildRepoPickerItems", () => {
  const defaultItem = {
    value: DEFAULT_REPO,
    label: `${DEFAULT_REPO} (default)`,
  };

  it("always shows the default repo first, even with no repos configured", () => {
    assert.deepEqual(buildRepoPickerItems([]), [
      defaultItem,
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("shows the default repo first, then configured repos, then Add repo", () => {
    assert.deepEqual(buildRepoPickerItems(["a/b", "c/d"]), [
      defaultItem,
      { value: "a/b", label: "a/b" },
      { value: "c/d", label: "c/d" },
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("marks the default repo with (default) and does not duplicate it", () => {
    const result = buildRepoPickerItems([DEFAULT_REPO, "a/b"]);
    assert.deepEqual(result, [
      defaultItem,
      { value: "a/b", label: "a/b" },
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("preserves the order of non-default input repos", () => {
    const repos = ["z/y", "a/b", "m/n"];
    const result = buildRepoPickerItems(repos);
    // Strip the leading default item and trailing Add repo item.
    assert.deepEqual(
      result.slice(1, result.length - 1).map((r) => r.value),
      repos,
    );
  });

  it("always has exactly one default item and one Add repo item", () => {
    assert.equal(buildRepoPickerItems([]).length, 2);
    assert.equal(buildRepoPickerItems(["a/b"]).length, 3);
    assert.equal(buildRepoPickerItems(["a/b", "c/d", "e/f"]).length, 5);
    // Default repo is not duplicated when also configured.
    assert.equal(buildRepoPickerItems([DEFAULT_REPO, "a/b"]).length, 3);
  });

  it("places the Add repo item last in the list", () => {
    const result = buildRepoPickerItems(["a/b", "c/d"]);
    assert.equal(result[result.length - 1]!.value, REPO_ADD_ACTION);
  });
});

describe("DEFAULT_REPO", () => {
  it("is a non-empty owner/repo string", () => {
    assert.equal(typeof DEFAULT_REPO, "string");
    assert.match(DEFAULT_REPO, /^[^/]+\/[^/]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// setAssertDefault — flip the on-disk `default` flag of a single assert
// in a known asserts.json file.  Used by the /asserts UI `t` keybinding.
// ═══════════════════════════════════════════════════════════════════

describe("setAssertDefault", () => {
  type Case = {
    label: string;
    /** Use the project file? (false → global file under tmpRoot) */
    useProject: boolean;
    initialJson: object;
    source: string;
    name: string;
    value: boolean;
    expectedEntry: Record<string, unknown>;
    /** Expected top-level keys after the write (preserved structure). */
    expectedTopLevel: Record<string, unknown>;
  };

  const projectPath = (cwd: string) => join(cwd, ".pi", "asserts.json");
  const globalPath = () => join(tmpRoot, ".pi", "asserts.json");

  const cases: Case[] = [
    // ── Setting default: true ────────────────────────────────────
    {
      label: "adds `default: true` to an assert that had no `default` field",
      useProject: true,
      initialJson: {
        local: { "no-default": { hook: "tool_call", shell: "true" } },
      },
      source: "local",
      name: "no-default",
      value: true,
      expectedEntry: { hook: "tool_call", shell: "true", default: true },
      expectedTopLevel: {
        local: { "no-default": { hook: "tool_call", shell: "true", default: true } },
      },
    },
    {
      label: "flips `default: false` to `default: true`",
      useProject: true,
      initialJson: {
        local: { rule: { hook: "tool_call", shell: "false", default: false } },
      },
      source: "local",
      name: "rule",
      value: true,
      expectedEntry: { hook: "tool_call", shell: "false", default: true },
      expectedTopLevel: {
        local: { rule: { hook: "tool_call", shell: "false", default: true } },
      },
    },
    {
      label: "preserves sibling keys when adding `default`",
      useProject: true,
      initialJson: {
        local: {
          rule: {
            hook: "tool_call",
            filter: { toolName: "bash" },
            when: "true",
            shell: "false",
          },
        },
      },
      source: "local",
      name: "rule",
      value: true,
      expectedEntry: {
        hook: "tool_call",
        filter: { toolName: "bash" },
        when: "true",
        shell: "false",
        default: true,
      },
      expectedTopLevel: {
        local: {
          rule: {
            hook: "tool_call",
            filter: { toolName: "bash" },
            when: "true",
            shell: "false",
            default: true,
          },
        },
      },
    },

    // ── Setting default: false (delete the key) ─────────────────
    {
      label: "deletes the `default` key when called with false (instead of writing false)",
      useProject: true,
      initialJson: {
        local: { rule: { hook: "tool_call", shell: "false", default: true } },
      },
      source: "local",
      name: "rule",
      value: false,
      expectedEntry: { hook: "tool_call", shell: "false" },
      expectedTopLevel: {
        local: { rule: { hook: "tool_call", shell: "false" } },
      },
    },
    {
      label: "deleting `default` from an entry that has none is a no-op (still not present)",
      useProject: true,
      initialJson: {
        local: { rule: { hook: "tool_call", shell: "true" } },
      },
      source: "local",
      name: "rule",
      value: false,
      expectedEntry: { hook: "tool_call", shell: "true" },
      expectedTopLevel: {
        local: { rule: { hook: "tool_call", shell: "true" } },
      },
    },

    // ── Preserves surrounding file structure ────────────────────
    {
      label: "preserves the rest of the file's structure and content",
      useProject: true,
      initialJson: {
        $schema: "https://example.com/schema.json",
        repos: ["owner/repo"],
        local: {
          a: { hook: "tool_call", shell: "true" },
          b: { hook: "tool_call", shell: "false", default: true },
        },
        "owner/repo": {
          c: { hook: "tool_call", shell: "false" },
        },
      },
      source: "owner/repo",
      name: "c",
      value: true,
      expectedEntry: { hook: "tool_call", shell: "false", default: true },
      expectedTopLevel: {
        $schema: "https://example.com/schema.json",
        repos: ["owner/repo"],
        local: {
          a: { hook: "tool_call", shell: "true" },
          b: { hook: "tool_call", shell: "false", default: true },
        },
        "owner/repo": {
          c: { hook: "tool_call", shell: "false", default: true },
        },
      },
    },

    // ── Works against the global file too ────────────────────────
    {
      label: "writes to the global file when given a global path",
      useProject: false,
      initialJson: {
        local: { "g-rule": { hook: "tool_call", shell: "true" } },
      },
      source: "local",
      name: "g-rule",
      value: true,
      expectedEntry: { hook: "tool_call", shell: "true", default: true },
      expectedTopLevel: {
        local: { "g-rule": { hook: "tool_call", shell: "true", default: true } },
      },
    },
  ];

  for (const {
    label,
    useProject,
    initialJson,
    source,
    name,
    value,
    expectedTopLevel,
  } of cases) {
    it(label, () => {
      const cwd = join(tmpRoot, `set-default-${label.replace(/[^a-z0-9-]/gi, "-")}`);

      // Reset global state from the loadAsserts suite so it doesn't
      // bleed into this test.
      try {
        rmSync(join(tmpRoot, ".pi"), { recursive: true, force: true });
      } catch { /* ok */ }

      const path = useProject ? projectPath(cwd) : globalPath();
      // Ensure the parent dir exists for the global-path case
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(initialJson));

      setAssertDefault(path, source, name, value);

      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, expectedTopLevel);
    });
  }

  // ── Throws cases ─────────────────────────────────────────────

  type ThrowsCase = {
    label: string;
    useProject: boolean;
    initialJson: object | undefined;
    source: string;
    name: string;
    value: boolean;
    errorPattern: RegExp;
  };

  const throwsCases: ThrowsCase[] = [
    {
      label: "throws when the section is missing",
      useProject: true,
      initialJson: { local: { rule: { hook: "tool_call", shell: "true" } } },
      source: "other/repo",
      name: "rule",
      value: true,
      errorPattern: /not found in section/,
    },
    {
      label: "throws when the assert is missing in the section",
      useProject: true,
      initialJson: { local: { rule: { hook: "tool_call", shell: "true" } } },
      source: "local",
      name: "nonexistent",
      value: true,
      errorPattern: /not found in section/,
    },
    {
      label: "throws when the file is missing",
      useProject: true,
      initialJson: undefined,
      source: "local",
      name: "rule",
      value: true,
      errorPattern: /not found in section/,
    },
    {
      label: "throws when the assert value is not an object",
      useProject: true,
      initialJson: { local: { "bad-rule": "just a string" } },
      source: "local",
      name: "bad-rule",
      value: true,
      errorPattern: /is not an object/,
    },
  ];

  for (const {
    label,
    useProject,
    initialJson,
    source,
    name,
    value,
    errorPattern,
  } of throwsCases) {
    it(label, () => {
      const cwd = join(tmpRoot, `set-default-throws-${label.replace(/[^a-z0-9-]/gi, "-")}`);

      try {
        rmSync(join(tmpRoot, ".pi"), { recursive: true, force: true });
      } catch { /* ok */ }

      const path = useProject ? projectPath(cwd) : globalPath();
      if (initialJson !== undefined) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, JSON.stringify(initialJson));
      } else {
        // Make sure neither the project nor the global file exists
        try { rmSync(join(path, ".."), { recursive: true, force: true }); } catch { /* ok */ }
      }

      assert.throws(() => setAssertDefault(path, source, name, value), errorPattern);
    });
  }

  // ── File is rewritten with 2-space indent + trailing newline ─

  it("writes the file as pretty-printed JSON (2-space indent) with a trailing newline", () => {
    const cwd = join(tmpRoot, "set-default-pretty");
    try {
      rmSync(join(tmpRoot, ".pi"), { recursive: true, force: true });
    } catch { /* ok */ }
    const path = projectPath(cwd);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ local: { r: { hook: "tool_call", shell: "true" } } }),
    );

    setAssertDefault(path, "local", "r", true);

    const raw = readFileSync(path, "utf-8");
    assert.match(raw, /\n$/, "trailing newline");
    assert.match(raw, /^\{\n {2}"local"/, "2-space indent");
    assert.match(raw, /"default": true/);
  });
});
