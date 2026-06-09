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
  type RuleEntries,
} from "../pi-assert/install.js";

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
  it("returns only .json files and strips extension", async () => {
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse([
        mockDirItem("defaults.json", "rules/defaults.json"),
        mockDirItem("security.json", "rules/security.json"),
      ]),
    );

    const files = await fetchRuleFiles("meffmadd/pi-assert-rules");
    assert.strictEqual(files.length, 2);
    assert.strictEqual(files[0].name, "defaults");
    assert.strictEqual(files[0].path, "rules/defaults.json");
    assert.strictEqual(files[1].name, "security");
    assert.strictEqual(files[1].path, "rules/security.json");
  });

  it("filters out non-.json files", async () => {
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse([
        mockDirItem("defaults.json", "rules/defaults.json"),
        mockDirItem("README.md", "rules/README.md"),
      ]),
    );

    const files = await fetchRuleFiles("meffmadd/pi-assert-rules");
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].name, "defaults");
  });

  it("filters out directories", async () => {
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse([
        mockDirItem("defaults.json", "rules/defaults.json"),
        mockDirItem("subdir", "rules/subdir", "dir"),
      ]),
    );

    const files = await fetchRuleFiles("meffmadd/pi-assert-rules");
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].name, "defaults");
  });

  it("returns [] for empty rules/ directory", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse([]));
    const files = await fetchRuleFiles("meffmadd/pi-assert-rules");
    assert.deepStrictEqual(files, []);
  });

  it("throws on 404", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse({}, 404));
    await assert.rejects(
      () => fetchRuleFiles("meffmadd/pi-assert-rules"),
      /404/,
    );
  });

  it("throws on 403", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse({}, 403));
    await assert.rejects(
      () => fetchRuleFiles("meffmadd/pi-assert-rules"),
      /403/,
    );
  });

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
  it("parses a valid rules file with multiple entries", async () => {
    const content = {
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
    };

    mock.method(globalThis, "fetch", () =>
      mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", content),
      ),
    );

    const entries = await fetchRuleFile(
      "meffmadd/pi-assert-rules",
      "rules/defaults.json",
    );

    assert.strictEqual(Object.keys(entries).length, 2);
    assert.strictEqual(entries["block-write"]?.description, "Blocks all write calls.");
    assert.strictEqual(entries["block-write"]?.hook, "tool_call");
    assert.deepStrictEqual(entries["block-write"]?.filter, { toolName: "write" });
    assert.strictEqual(entries["block-write"]?.shell, "false");
    assert.strictEqual(entries["no-rm-rf"]?.shell, "grep rm");
  });

  it("skips entries missing description", async () => {
    const content = {
      valid: { description: "Valid entry.", hook: "tool_call", shell: "true" },
      "no-desc": { hook: "tool_call", shell: "false" },
    };

    mock.method(globalThis, "fetch", () =>
      mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", content),
      ),
    );

    const entries = await fetchRuleFile(
      "meffmadd/pi-assert-rules",
      "rules/defaults.json",
    );

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
    assert.strictEqual(entries["no-desc"], undefined);
  });

  it("skips entries missing hook", async () => {
    const content = {
      "no-hook": { description: "Missing hook.", shell: "false" },
      valid: { description: "Valid.", hook: "tool_call", shell: "true" },
    };

    mock.method(globalThis, "fetch", () =>
      mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", content),
      ),
    );

    const entries = await fetchRuleFile(
      "meffmadd/pi-assert-rules",
      "rules/defaults.json",
    );

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
  });

  it("skips entries missing shell", async () => {
    const content = {
      "no-shell": { description: "Missing shell.", hook: "tool_call" },
      valid: { description: "Valid.", hook: "tool_call", shell: "true" },
    };

    mock.method(globalThis, "fetch", () =>
      mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", content),
      ),
    );

    const entries = await fetchRuleFile(
      "meffmadd/pi-assert-rules",
      "rules/defaults.json",
    );

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
  });

  it("skips non-object entries (null, string)", async () => {
    const content = {
      nil: null,
      str: "just a string",
      valid: { description: "Valid.", hook: "tool_call", shell: "true" },
    };

    mock.method(globalThis, "fetch", () =>
      mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", content),
      ),
    );

    const entries = await fetchRuleFile(
      "meffmadd/pi-assert-rules",
      "rules/defaults.json",
    );

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
  });

  it("throws when response has no content (not a file)", async () => {
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse({ type: "dir", name: "rules", path: "rules" }),
    );

    await assert.rejects(
      () => fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /Not a file/,
    );
  });

  it("throws on non-JSON content", async () => {
    const b64 = Buffer.from("not valid json!!!").toString("base64");
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse({
        type: "file",
        name: "defaults.json",
        path: "rules/defaults.json",
        content: b64,
        encoding: "base64",
      }),
    );

    await assert.rejects(
      () => fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /JSON/,
    );
  });

  it("throws when content is a JSON array", async () => {
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", [1, 2, 3]),
      ),
    );

    await assert.rejects(
      () => fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /not a JSON object/,
    );
  });

  it("throws on HTTP error", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse({}, 500));

    await assert.rejects(
      () => fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /500/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// installRule
// ═══════════════════════════════════════════════════════════════════

describe("installRule", () => {
  it("writes to fresh .pi/asserts.json under correct repo key", () => {
    const cwd = join(tmpRoot, "fresh");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "meffmadd/pi-assert-rules", "my-rule", {
      description: "A test rule.",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed["meffmadd/pi-assert-rules"], {
      "my-rule": { hook: "tool_call", shell: "false" },
    });
    assert.deepStrictEqual(parsed.repos, ["meffmadd/pi-assert-rules"]);
    assert.strictEqual(Object.keys(parsed).length, 2);
  });

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

  it("merges into existing file (preserves other sections)", () => {
    const cwd = join(tmpRoot, "merge");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        local: { existing: { hook: "tool_call", shell: "true" } },
      }),
    );

    installRule(cwd, "meffmadd/pi-assert-rules", "new-rule", {
      description: "New rule.",
      hook: "tool_call",
      filter: { toolName: "bash" },
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(Object.keys(parsed).length, 3);
    assert.deepStrictEqual(parsed.local, {
      existing: { hook: "tool_call", shell: "true" },
    });
    assert.deepStrictEqual(parsed["meffmadd/pi-assert-rules"], {
      "new-rule": { hook: "tool_call", filter: { toolName: "bash" }, shell: "false" },
    });
    assert.deepStrictEqual(parsed.repos, ["meffmadd/pi-assert-rules"]);
  });

  it("overwrites existing key with same name in same repo", () => {
    const cwd = join(tmpRoot, "overwrite");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        "meffmadd/pi-assert-rules": {
          "my-rule": { hook: "tool_call", shell: "old" },
        },
      }),
    );

    installRule(cwd, "meffmadd/pi-assert-rules", "my-rule", {
      description: "Updated.",
      hook: "tool_call",
      shell: "new",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed["meffmadd/pi-assert-rules"]["my-rule"], {
      hook: "tool_call",
      shell: "new",
    });
  });

  it("strips description from written output", () => {
    const cwd = join(tmpRoot, "strip-desc");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "some/repo", "my-rule", {
      description: "This should NOT appear.",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    const entry = parsed["some/repo"]["my-rule"];
    assert.strictEqual("description" in entry, false);
    assert.deepStrictEqual(entry, { hook: "tool_call", shell: "false" });
  });

  it("only writes schema-valid fields", () => {
    const cwd = join(tmpRoot, "schema-fields");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "some/repo", "my-rule", {
      description: "stripped",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed["some/repo"]["my-rule"]).sort();

    assert.deepStrictEqual(keys, ["hook", "shell"]);
  });

  it("handles broken existing JSON (starts fresh)", () => {
    const cwd = join(tmpRoot, "broken-json");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "asserts.json"), "{not valid json!!!");

    installRule(cwd, "some/repo", "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "true",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed["some/repo"], {
      "my-rule": { hook: "tool_call", shell: "true" },
    });
    assert.deepStrictEqual(parsed.repos, ["some/repo"]);
  });

  it("writes filter when present", () => {
    const cwd = join(tmpRoot, "with-filter");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "some/repo", "my-rule", {
      description: "Test.",
      hook: "tool_call",
      filter: { toolName: "write" },
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(
      parsed["some/repo"]["my-rule"].filter,
      { toolName: "write" },
    );
  });

  it("writes when when present", () => {
    const cwd = join(tmpRoot, "with-when");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "some/repo", "my-rule", {
      description: "Test.",
      hook: "tool_call",
      when: "git diff --quiet",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(
      parsed["some/repo"]["my-rule"].when,
      "git diff --quiet",
    );
  });

  it("writes default when present", () => {
    const cwd = join(tmpRoot, "with-default");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "some/repo", "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "false",
      default: true,
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(parsed["some/repo"]["my-rule"].default, true);
  });

  it("omits optional fields when absent", () => {
    const cwd = join(tmpRoot, "no-optionals");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "some/repo", "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed["some/repo"]["my-rule"]).sort();

    assert.deepStrictEqual(keys, ["hook", "shell"]);
  });

  it("writes all optional fields when all present", () => {
    const cwd = join(tmpRoot, "all-fields");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "some/repo", "my-rule", {
      description: "Test.",
      hook: "tool_call",
      filter: { toolName: "bash" },
      when: "true",
      shell: "false",
      default: true,
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed["some/repo"]["my-rule"]).sort();

    assert.deepStrictEqual(keys, ["default", "filter", "hook", "shell", "when"]);
  });

  it("installs into a second repo without clobbering the first", () => {
    const cwd = join(tmpRoot, "two-repos");
    mkdirSync(join(cwd, ".pi"), { recursive: true });

    installRule(cwd, "repo/a", "rule1", {
      description: "First.",
      hook: "tool_call",
      shell: "true",
    });
    installRule(cwd, "repo/b", "rule2", {
      description: "Second.",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed["repo/a"], {
      rule1: { hook: "tool_call", shell: "true" },
    });
    assert.deepStrictEqual(parsed["repo/b"], {
      rule2: { hook: "tool_call", shell: "false" },
    });
    assert.deepStrictEqual(parsed.repos, ["repo/a", "repo/b"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// removeRule
// ═══════════════════════════════════════════════════════════════════

describe("removeRule", () => {
  it("removes an existing assert from a repo section", () => {
    const cwd = join(tmpRoot, "remove-existing");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        local: { "keep-me": { hook: "tool_call", shell: "true" } },
        "some/repo": { "drop-me": { hook: "tool_call", shell: "false" } },
      }),
    );

    const result = removeRule(cwd, "some/repo", "drop-me");
    assert.strictEqual(result, true);

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(Object.keys(parsed).length, 1);
    assert.ok("local" in parsed);
    assert.strictEqual("some/repo" in parsed, false); // section pruned
  });

  it("prunes empty repo section", () => {
    const cwd = join(tmpRoot, "prune-section");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        "some/repo": { "only-me": { hook: "tool_call", shell: "true" } },
      }),
    );

    removeRule(cwd, "some/repo", "only-me");

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(Object.keys(parsed).length, 0);
  });

  it("returns false when assert not found", () => {
    const cwd = join(tmpRoot, "remove-missing");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        "some/repo": { "my-rule": { hook: "tool_call", shell: "true" } },
      }),
    );

    const result = removeRule(cwd, "some/repo", "nonexistent");
    assert.strictEqual(result, false);
  });

  it("returns false when repo section missing", () => {
    const cwd = join(tmpRoot, "remove-no-repo");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        local: { "my-rule": { hook: "tool_call", shell: "true" } },
      }),
    );

    const result = removeRule(cwd, "other/repo", "anything");
    assert.strictEqual(result, false);
  });

  it("returns false when file missing", () => {
    const result = removeRule(join(tmpRoot, "no-file"), "any/repo", "anything");
    assert.strictEqual(result, false);
  });

  it("returns false on broken JSON", () => {
    const cwd = join(tmpRoot, "remove-broken");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "asserts.json"), "not json!!!");

    const result = removeRule(cwd, "any/repo", "anything");
    assert.strictEqual(result, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getInstalledRepos
// ═══════════════════════════════════════════════════════════════════

describe("getInstalledRepos", () => {
  it("returns repo keys (excluding local and $schema)", () => {
    const cwd = join(tmpRoot, "installed-repos");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        $schema: "https://example.com/schema.json",
        repos: ["meffmadd/pi-assert-rules", "other/repo"],
        local: { rule: { hook: "tool_call", shell: "true" } },
        "meffmadd/pi-assert-rules": { block: { hook: "tool_call", shell: "false" } },
        "other/repo": { another: { hook: "tool_call", shell: "true" } },
      }),
    );

    const repos = getInstalledRepos(cwd);
    assert.deepStrictEqual(repos.sort(), [
      "meffmadd/pi-assert-rules",
      "other/repo",
    ]);
  });

  it("returns [] when no repo sections exist", () => {
    const cwd = join(tmpRoot, "no-repos");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        local: { rule: { hook: "tool_call", shell: "true" } },
      }),
    );

    const repos = getInstalledRepos(cwd);
    assert.deepStrictEqual(repos, []);
  });

  it("returns [] when file missing", () => {
    const repos = getInstalledRepos(join(tmpRoot, "no-file"));
    assert.deepStrictEqual(repos, []);
  });
});

// ═══════════════════════════════════════════════════════════════════
// addRepo
// ═══════════════════════════════════════════════════════════════════

describe("addRepo", () => {
  it("adds a repo to the repos array", () => {
    const cwd = join(tmpRoot, "add-repo-fresh");
    mkdirSync(cwd, { recursive: true });

    addRepo(cwd, "meffmadd/pi-assert-rules");

    const repos = getInstalledRepos(cwd);
    assert.deepStrictEqual(repos, ["meffmadd/pi-assert-rules"]);
  });

  it("appends to existing repos", () => {
    const cwd = join(tmpRoot, "add-repo-append");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        repos: ["repo/a"],
        local: { rule: { hook: "tool_call", shell: "true" } },
      }),
    );

    addRepo(cwd, "repo/b");

    const repos = getInstalledRepos(cwd);
    assert.deepStrictEqual(repos, ["repo/a", "repo/b"]);
  });

  it("no-op when repo already present", () => {
    const cwd = join(tmpRoot, "add-repo-dup");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        repos: ["repo/a"],
      }),
    );

    addRepo(cwd, "repo/a");

    const repos = getInstalledRepos(cwd);
    assert.deepStrictEqual(repos, ["repo/a"]);
  });

  it("throws on invalid format (no slash)", () => {
    const cwd = join(tmpRoot, "add-repo-bad");
    mkdirSync(cwd, { recursive: true });

    assert.throws(() => addRepo(cwd, "not-a-repo"), /Invalid repo format/);
  });

  it("preserves local section when adding repo", () => {
    const cwd = join(tmpRoot, "add-repo-local");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        local: { rule: { hook: "tool_call", shell: "true" } },
      }),
    );

    addRepo(cwd, "some/repo");

    const repos = getInstalledRepos(cwd);
    assert.deepStrictEqual(repos, ["some/repo"]);

    // local still intact
    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.ok("local" in parsed);
  });
});
