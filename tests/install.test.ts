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
  installRule,
  removeRule,
  addRepo,
  getInstalledRepos,
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

/** Real API response shape for a directory listing item. */
function mockDirItem(name: string, path: string, type = "file"): unknown {
  return {
    name,
    path,
    sha: "abc123",
    size: 100,
    url: `https://api.github.com/repos/meffmadd/pi-assert-rules/contents/${path}?ref=main`,
    html_url: `https://github.com/meffmadd/pi-assert-rules/blob/main/${path}`,
    git_url: `https://api.github.com/repos/meffmadd/pi-assert-rules/git/blobs/abc123`,
    download_url: `https://raw.githubusercontent.com/meffmadd/pi-assert-rules/main/${path}`,
    type,
    _links: {
      self: `https://api.github.com/repos/meffmadd/pi-assert-rules/contents/${path}?ref=main`,
      git: `https://api.github.com/repos/meffmadd/pi-assert-rules/git/blobs/abc123`,
      html: `https://github.com/meffmadd/pi-assert-rules/blob/main/${path}`,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// fetchRuleFiles
// ═══════════════════════════════════════════════════════════════════

describe("fetchRuleFiles", () => {
  type PassCase = { label: string; items: unknown[]; expected: RuleFile[] };

  const passCases: PassCase[] = [
    {
      label: "returns only .json files and strips extension",
      items: [
        mockDirItem("defaults.json", "rules/defaults.json"),
        mockDirItem("security.json", "rules/security.json"),
      ],
      expected: [
        { name: "defaults", path: "rules/defaults.json", sha: "abc123" },
        { name: "security", path: "rules/security.json", sha: "abc123" },
      ],
    },
    {
      label: "filters out non-.json files",
      items: [
        mockDirItem("defaults.json", "rules/defaults.json"),
        mockDirItem("README.md", "rules/README.md"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "filters out directories",
      items: [
        mockDirItem("defaults.json", "rules/defaults.json"),
        mockDirItem("subdir", "rules/subdir", "dir"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "returns [] for empty rules/ directory",
      items: [],
      expected: [],
    },
  ];

  for (const { label, items, expected } of passCases) {
    it(label, async () => {
      mock.method(globalThis, "fetch", () => mockJsonResponse(items));
      assert.deepStrictEqual(
        await fetchRuleFiles("meffmadd/pi-assert-rules"),
        expected,
      );
    });
  }

  // ── Throws cases ────────────────────────────────────────────────

  type ThrowsCase = { label: string; body: unknown; status: number; errorPattern: RegExp };

  const throwsCases: ThrowsCase[] = [
    { label: "throws on 404", body: {}, status: 404, errorPattern: /404/ },
    { label: "throws on 403", body: {}, status: 403, errorPattern: /403/ },
  ];

  for (const { label, body, status, errorPattern } of throwsCases) {
    it(label, async () => {
      mock.method(globalThis, "fetch", () => mockJsonResponse(body, status));
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
        "meffmadd/pi-assert-rules": { "my-rule": { hook: "tool_call", shell: "false" } },
        repos: ["meffmadd/pi-assert-rules"],
      },
    },
    {
      label: "strips description from written output",
      initialJson: undefined,
      repo: "some/repo",
      name: "my-rule",
      entry: { description: "This should NOT appear.", hook: "tool_call", shell: "false" },
      expected: {
        "some/repo": { "my-rule": { hook: "tool_call", shell: "false" } },
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
        "some/repo": { "my-rule": { hook: "tool_call", filter: { toolName: "write" }, shell: "false" } },
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
        "some/repo": { "my-rule": { hook: "tool_call", when: "git diff --quiet", shell: "false" } },
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
        "some/repo": { "my-rule": { hook: "tool_call", shell: "false", default: true } },
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
        "some/repo": { "my-rule": { hook: "tool_call", shell: "false" } },
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
          "my-rule": { hook: "tool_call", filter: { toolName: "bash" }, when: "true", shell: "false", default: true },
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
        "meffmadd/pi-assert-rules": { "new-rule": { hook: "tool_call", filter: { toolName: "bash" }, shell: "false" } },
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
        "meffmadd/pi-assert-rules": { "my-rule": { hook: "tool_call", shell: "new" } },
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
        "some/repo": { "my-rule": { hook: "tool_call", shell: "true" } },
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
        "repo/a": { rule1: { hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { hook: "tool_call", shell: "false" } },
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
        "meffmadd/pi-assert-rules": { "my-rule": { hook: "tool_call", shell: "false" } },
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
  it("returns only the Add repo item when no repos are configured", () => {
    assert.deepEqual(buildRepoPickerItems([]), [
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("lists existing repos first, then the Add repo item", () => {
    assert.deepEqual(buildRepoPickerItems(["a/b", "c/d"]), [
      { value: "a/b", label: "a/b" },
      { value: "c/d", label: "c/d" },
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("preserves the order of input repos", () => {
    const repos = ["z/y", "a/b", "m/n"];
    const result = buildRepoPickerItems(repos);
    assert.deepEqual(
      result.slice(0, repos.length).map((r) => r.value),
      repos,
    );
  });

  it("appends exactly one Add repo item regardless of input size", () => {
    assert.equal(buildRepoPickerItems([]).length, 1);
    assert.equal(buildRepoPickerItems(["a/b"]).length, 2);
    assert.equal(buildRepoPickerItems(["a/b", "c/d", "e/f"]).length, 4);
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
