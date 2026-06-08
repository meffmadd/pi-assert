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
  // 1.1 ── Returns only .json files ────────────────────────────────
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

  // 1.2 ── Filters out non-.json files ─────────────────────────────
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

  // 1.3 ── Filters out directories ─────────────────────────────────
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

  // 1.4 ── Empty rules/ dir ────────────────────────────────────────
  it("returns [] for empty rules/ directory", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse([]));

    const files = await fetchRuleFiles("meffmadd/pi-assert-rules");
    assert.deepStrictEqual(files, []);
  });

  // 1.5 ── 404 error ───────────────────────────────────────────────
  it("throws on 404", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse({}, 404));

    await assert.rejects(
      () => fetchRuleFiles("meffmadd/pi-assert-rules"),
      /404/,
    );
  });

  // 1.6 ── 403 error (rate limit) ──────────────────────────────────
  it("throws on 403", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse({}, 403));

    await assert.rejects(
      () => fetchRuleFiles("meffmadd/pi-assert-rules"),
      /403/,
    );
  });

  // 1.7 ── Network error ───────────────────────────────────────────
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
  // 2.1 ── Parses valid multi-entry file ───────────────────────────
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

  // 2.2 ── Skips entry missing `description` ───────────────────────
  it("skips entries missing description", async () => {
    const content = {
      valid: {
        description: "Valid entry.",
        hook: "tool_call",
        shell: "true",
      },
      "no-desc": {
        hook: "tool_call",
        shell: "false",
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

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
    assert.strictEqual(entries["no-desc"], undefined);
  });

  // 2.3 ── Skips entry missing `hook` ──────────────────────────────
  it("skips entries missing hook", async () => {
    const content = {
      "no-hook": {
        description: "Missing hook.",
        shell: "false",
      },
      valid: {
        description: "Valid.",
        hook: "tool_call",
        shell: "true",
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

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
  });

  // 2.4 ── Skips entry missing `shell` ─────────────────────────────
  it("skips entries missing shell", async () => {
    const content = {
      "no-shell": {
        description: "Missing shell.",
        hook: "tool_call",
      },
      valid: {
        description: "Valid.",
        hook: "tool_call",
        shell: "true",
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

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
  });

  // 2.5 ── Skips non-object entries ────────────────────────────────
  it("skips non-object entries (null, string)", async () => {
    const content = {
      nil: null,
      str: "just a string",
      valid: {
        description: "Valid.",
        hook: "tool_call",
        shell: "true",
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

    assert.strictEqual(Object.keys(entries).length, 1);
    assert.ok(entries.valid);
  });

  // 2.6 ── Throws when response is not a file ──────────────────────
  it("throws when response has no content (not a file)", async () => {
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse({ type: "dir", name: "rules", path: "rules" }),
    );

    await assert.rejects(
      () =>
        fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /Not a file/,
    );
  });

  // 2.7 ── Throws on non-JSON content ──────────────────────────────
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
      () =>
        fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /JSON/,
    );
  });

  // 2.8 ── Throws when content is a JSON array ─────────────────────
  it("throws when content is a JSON array", async () => {
    mock.method(globalThis, "fetch", () =>
      mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", [1, 2, 3]),
      ),
    );

    await assert.rejects(
      () =>
        fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /not a JSON object/,
    );
  });

  // 2.9 ── Throws on HTTP error ────────────────────────────────────
  it("throws on HTTP error", async () => {
    mock.method(globalThis, "fetch", () => mockJsonResponse({}, 500));

    await assert.rejects(
      () =>
        fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
      /500/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// installRule
// ═══════════════════════════════════════════════════════════════════

describe("installRule", () => {
  // 3.1 ── Fresh install (no prior file) ───────────────────────────
  it("writes to fresh .pi/asserts.json", () => {
    const cwd = join(tmpRoot, "fresh");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "A test rule.",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed, {
      "my-rule": {
        hook: "tool_call",
        shell: "false",
        protected: false,
      },
    });
  });

  // 3.2 ── Creates .pi/ directory when missing ─────────────────────
  it("creates .pi/ directory if missing", () => {
    const cwd = join(tmpRoot, "no-pi-dir");
    mkdirSync(cwd, { recursive: true });
    // Make sure .pi/ does NOT exist yet
    assert.strictEqual(existsSync(join(cwd, ".pi")), false);

    installRule(cwd, "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "true",
    });

    assert.strictEqual(existsSync(join(cwd, ".pi")), true);
    assert.strictEqual(existsSync(join(cwd, ".pi", "asserts.json")), true);
  });

  // 3.3 ── Merges into existing file ───────────────────────────────
  it("merges into existing file (preserves other keys)", () => {
    const cwd = join(tmpRoot, "merge");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({ existing: { hook: "tool_call", shell: "true" } }),
    );

    installRule(cwd, "new-rule", {
      description: "New rule.",
      hook: "tool_call",
      filter: { toolName: "bash" },
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(Object.keys(parsed).length, 2);
    assert.deepStrictEqual(parsed.existing, {
      hook: "tool_call",
      shell: "true",
    });
    assert.deepStrictEqual(parsed["new-rule"], {
      hook: "tool_call",
      filter: { toolName: "bash" },
      shell: "false",
      protected: false,
    });
  });

  // 3.4 ── Overwrites existing key ─────────────────────────────────
  it("overwrites existing key with same name", () => {
    const cwd = join(tmpRoot, "overwrite");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({ "my-rule": { hook: "tool_call", shell: "old" } }),
    );

    installRule(cwd, "my-rule", {
      description: "Updated.",
      hook: "tool_call",
      shell: "new",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed["my-rule"], {
      hook: "tool_call",
      shell: "new",
      protected: false,
    });
  });

  // 3.5 ── Strips description from output ──────────────────────────
  it("strips description from written output", () => {
    const cwd = join(tmpRoot, "strip-desc");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "This should NOT appear in the file.",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual("description" in parsed["my-rule"], false);
    assert.deepStrictEqual(parsed["my-rule"], {
      hook: "tool_call",
      shell: "false",
      protected: false,
    });
  });

  // 3.6 ── Only writes schema-valid fields ─────────────────────────
  it("only writes hook, shell, filter, when, default", () => {
    const cwd = join(tmpRoot, "schema-fields");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "stripped",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed["my-rule"]).sort();

    assert.deepStrictEqual(keys, ["hook", "protected", "shell"]);
  });

  // 3.7 ── Handles broken existing JSON ────────────────────────────
  it("handles broken existing JSON (starts fresh)", () => {
    const cwd = join(tmpRoot, "broken-json");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "asserts.json"), "{not valid json!!!");

    // Should not throw
    installRule(cwd, "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "true",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed, {
      "my-rule": { hook: "tool_call", shell: "true", protected: false },
    });
  });

  // 3.8 ── Writes filter when present ──────────────────────────────
  it("writes filter when present", () => {
    const cwd = join(tmpRoot, "with-filter");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "Test.",
      hook: "tool_call",
      filter: { toolName: "write" },
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.deepStrictEqual(parsed["my-rule"].filter, { toolName: "write" });
  });

  // 3.9 ── Writes when when present ────────────────────────────────
  it("writes when when present", () => {
    const cwd = join(tmpRoot, "with-when");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "Test.",
      hook: "tool_call",
      when: "git diff --quiet",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(parsed["my-rule"].when, "git diff --quiet");
  });

  // 3.10 ── Writes default when present ────────────────────────────
  it("writes default when present", () => {
    const cwd = join(tmpRoot, "with-default");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "false",
      default: true,
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(parsed["my-rule"].default, true);
  });

  // 3.11 ── Omits optional fields when absent ──────────────────────
  it("omits optional fields when absent", () => {
    const cwd = join(tmpRoot, "no-optionals");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "Test.",
      hook: "tool_call",
      shell: "false",
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed["my-rule"]).sort();

    assert.deepStrictEqual(keys, ["hook", "protected", "shell"]);
  });

  // 3.12 ── Writes all optional fields together ────────────────────
  it("writes all optional fields when all present", () => {
    const cwd = join(tmpRoot, "all-fields");
    mkdirSync(cwd, { recursive: true });

    installRule(cwd, "my-rule", {
      description: "Test.",
      hook: "tool_call",
      filter: { toolName: "bash" },
      when: "true",
      shell: "false",
      default: true,
    });

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed["my-rule"]).sort();

    assert.deepStrictEqual(keys, ["default", "filter", "hook", "protected", "shell", "when"]);
    assert.strictEqual(parsed["my-rule"].default, true);
    assert.deepStrictEqual(parsed["my-rule"].filter, { toolName: "bash" });
    assert.strictEqual(parsed["my-rule"].hook, "tool_call");
    assert.strictEqual(parsed["my-rule"].shell, "false");
    assert.strictEqual(parsed["my-rule"].when, "true");
  });
});

// ═══════════════════════════════════════════════════════════════════
// removeRule
// ═══════════════════════════════════════════════════════════════════

describe("removeRule", () => {
  // 4.1 ── Removes an existing assert ──────────────────────────────
  it("removes an existing assert", () => {
    const cwd = join(tmpRoot, "remove-existing");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({
        "keep-me": { hook: "tool_call", shell: "true" },
        "drop-me": { hook: "tool_call", shell: "false" },
      }),
    );

    const result = removeRule(cwd, "drop-me");
    assert.strictEqual(result, true);

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(Object.keys(parsed).length, 1);
    assert.ok("keep-me" in parsed);
    assert.strictEqual("drop-me" in parsed, false);
  });

  // 4.2 ── No-op when assert doesn't exist ─────────────────────────
  it("returns false when assert not found", () => {
    const cwd = join(tmpRoot, "remove-missing");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({ "my-rule": { hook: "tool_call", shell: "true" } }),
    );

    const result = removeRule(cwd, "nonexistent");
    assert.strictEqual(result, false);
  });

  // 4.3 ── Returns false when file doesn't exist ───────────────────
  it("returns false when file missing", () => {
    const result = removeRule(join(tmpRoot, "no-file"), "anything");
    assert.strictEqual(result, false);
  });

  // 4.4 ── Handles broken JSON ────────────────────────────────────
  it("returns false on broken JSON", () => {
    const cwd = join(tmpRoot, "remove-broken");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "asserts.json"), "not json!!!");

    const result = removeRule(cwd, "anything");
    assert.strictEqual(result, false);
  });

  // 4.5 ── Removes last assert (file becomes empty object) ─────────
  it("leaves empty object when removing last assert", () => {
    const cwd = join(tmpRoot, "remove-last");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "asserts.json"),
      JSON.stringify({ "only-me": { hook: "tool_call", shell: "true" } }),
    );

    const result = removeRule(cwd, "only-me");
    assert.strictEqual(result, true);

    const raw = readFileSync(join(cwd, ".pi", "asserts.json"), "utf-8");
    const parsed = JSON.parse(raw);

    assert.strictEqual(typeof parsed, "object");
    assert.strictEqual(Object.keys(parsed).length, 0);
  });
});
