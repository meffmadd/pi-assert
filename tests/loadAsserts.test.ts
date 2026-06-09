/**
 * Tests for loadAsserts — config loading & merge with sectioned format.
 *
 * Usage: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadAsserts, type Assert } from "../pi-assert/engine.js";

// ── Temp dir helpers ───────────────────────────────────────────────

let tmpRoot: string;
let savedHome: string | undefined;

before(() => {
  tmpRoot = join(tmpdir(), `pi-assert-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  // Override HOME so global loads from our tmp dir
  savedHome = process.env.HOME;
  process.env.HOME = tmpRoot;
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
});

/** Remove the global asserts.json so tests start with clean global state. */
function clearGlobal() {
  try { rmSync(join(tmpRoot, ".pi"), { recursive: true, force: true }); } catch { /* ok */ }
}

function makeProject(rel: string, json: object) {
  const dir = join(tmpRoot, rel);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "asserts.json"), JSON.stringify(json, null, 2));
  return dir;
}

function makeGlobal(json: object) {
  mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
  writeFileSync(join(tmpRoot, ".pi", "asserts.json"), JSON.stringify(json, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// loadAsserts
// ═══════════════════════════════════════════════════════════════════

describe("loadAsserts", () => {
  // 1.1 ── Empty state (no files) ──────────────────────────────────

  it("empty state — no files exist → []", () => {
    clearGlobal();
    const cwd = join(tmpRoot, "no-config");
    mkdirSync(cwd, { recursive: true });

    const result = loadAsserts(cwd);
    assert.deepStrictEqual(result, []);
  });

  // 1.2 ── Project-only file (local section) ───────────────────────

  it("project-only file (local) → loads 1 assert", () => {
    clearGlobal();
    makeProject("proj-only", {
      local: {
        unmodified: {
          hook: "tool_call",
          filter: { toolName: "write" },
          shell: "false",
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "proj-only"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "unmodified");
    assert.strictEqual(result[0].source, "local");
    assert.strictEqual(result[0].hook, "tool_call");
    assert.deepStrictEqual(result[0].filter, { toolName: "write" });
    assert.strictEqual(result[0].shell, "false");
  });

  // 1.3 ── Global-only file ────────────────────────────────────────

  it("global-only file → loads 1 assert", () => {
    clearGlobal();
    const cwd = join(tmpRoot, "global-only");
    mkdirSync(cwd, { recursive: true });

    makeGlobal({
      local: {
        "no-secrets": {
          hook: "tool_call",
          filter: { toolName: "bash" },
          shell: 'grep -q SECRET <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
        },
      },
    });

    const result = loadAsserts(cwd);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "no-secrets");
    assert.strictEqual(result[0].hook, "tool_call");
    assert.deepStrictEqual(result[0].filter, { toolName: "bash" });
  });

  // 1.4 ── Project overrides global by source+name ─────────────────

  it("project overrides global by source+name", () => {
    clearGlobal();
    makeGlobal({
      local: {
        "no-secrets": {
          hook: "tool_call",
          filter: { toolName: "bash" },
          shell: "grep -q SECRET",
        },
        "global-only": {
          hook: "tool_call",
          shell: "false",
        },
      },
    });

    makeProject("proj-override", {
      local: {
        "no-secrets": {
          hook: "tool_call",
          filter: { toolName: "bash" },
          shell: "exit 0",
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "proj-override"));
    assert.strictEqual(result.length, 2);

    const noSecrets = result.find((a) => a.name === "no-secrets")!;
    assert.strictEqual(noSecrets.shell, "exit 0"); // project wins

    const globalOnly = result.find((a) => a.name === "global-only")!;
    assert.strictEqual(globalOnly.shell, "false"); // global passed through
  });

  // 1.5 ── Invalid entries silently skipped ────────────────────────

  it("invalid entries = silently skipped", () => {
    clearGlobal();
    makeProject("invalid-entries", {
      local: {
        "valid-one": { hook: "tool_call", shell: "true" },
        "no-hook": { shell: "true" },
        "no-shell": { hook: "tool_call" },
        "null-val": null as any,
      },
    });

    const result = loadAsserts(join(tmpRoot, "invalid-entries"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "valid-one");
  });

  it("all entries invalid → []", () => {
    clearGlobal();
    makeProject("all-invalid", {
      local: {
        x: { shell: "true" },
        y: { hook: "tool_call" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "all-invalid"));
    assert.strictEqual(result.length, 0);
  });

  // 1.6 ── Empty JSON object → [] ──────────────────────────────────

  it("empty json object → []", () => {
    clearGlobal();
    makeProject("empty-json", {});

    const result = loadAsserts(join(tmpRoot, "empty-json"));
    assert.deepStrictEqual(result, []);
  });

  // 1.7 ── Malformed JSON throws ────────────────────────────────────

  it("malformed JSON → throws", () => {
    clearGlobal();
    const dir = join(tmpRoot, "malformed");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "asserts.json"), "{broken");

    assert.throws(() => loadAsserts(dir));
  });

  // 1.8 ── Assert with no filter (optional) ────────────────────────

  it("assert without filter → filter is undefined", () => {
    clearGlobal();
    makeProject("no-filter", {
      local: {
        "catch-all": {
          hook: "tool_call",
          shell: "false",
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "no-filter"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "catch-all");
    assert.strictEqual(result[0].filter, undefined);
  });

  // 1.9 ── default field: true ─────────────────────────────────────

  it("default: true in JSON → Assert.default = true", () => {
    clearGlobal();
    makeProject("default-true", {
      local: {
        guard: {
          hook: "tool_call",
          shell: "false",
          default: true,
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "default-true"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "guard");
    assert.strictEqual(result[0].default, true);
  });

  // 1.10 ── default field: false ────────────────────────────────────

  it("default: false in JSON → Assert.default = false", () => {
    clearGlobal();
    makeProject("default-false", {
      local: {
        guard: {
          hook: "tool_call",
          shell: "false",
          default: false,
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "default-false"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "guard");
    assert.strictEqual(result[0].default, false);
  });

  // 1.11 ── default omitted → false ─────────────────────────────────

  it("default omitted → Assert.default = false", () => {
    clearGlobal();
    makeProject("default-omitted", {
      local: {
        guard: {
          hook: "tool_call",
          shell: "false",
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "default-omitted"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].default, false);
  });

  // 1.12 ── Mixed defaults ──────────────────────────────────────────

  it("mixed defaults → each assert gets its own default value", () => {
    clearGlobal();
    makeProject("default-mixed", {
      local: {
        active: { hook: "tool_call", shell: "false", default: true },
        inactive: { hook: "tool_call", shell: "true", default: false },
        unspecified: { hook: "tool_call", shell: "true" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "default-mixed"));
    assert.strictEqual(result.length, 3);

    const active = result.find((a) => a.name === "active")!;
    assert.strictEqual(active.default, true);

    const inactive = result.find((a) => a.name === "inactive")!;
    assert.strictEqual(inactive.default, false);

    const unspecified = result.find((a) => a.name === "unspecified")!;
    assert.strictEqual(unspecified.default, false);
  });

  // 1.13 ── when field (precondition) ───────────────────────────────

  it("when field present → Assert.when is the string", () => {
    clearGlobal();
    makeProject("when-present", {
      local: {
        conditional: {
          hook: "tool_call",
          shell: "false",
          when: '[ "$PI_TOOL_NAME" = write ]',
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "when-present"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "conditional");
    assert.strictEqual(result[0].when, '[ "$PI_TOOL_NAME" = write ]');
    assert.strictEqual(result[0].shell, "false");
  });

  it("when field absent → Assert.when is undefined", () => {
    clearGlobal();
    makeProject("when-absent", {
      local: {
        simple: {
          hook: "tool_call",
          shell: "true",
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "when-absent"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].when, undefined);
  });

  it("when field alongside filter → both loaded", () => {
    clearGlobal();
    makeProject("when-with-filter", {
      local: {
        guarded: {
          hook: "tool_call",
          filter: { toolName: "bash" },
          when: "true",
          shell: "false",
        },
      },
    });

    const result = loadAsserts(join(tmpRoot, "when-with-filter"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "guarded");
    assert.deepStrictEqual(result[0].filter, { toolName: "bash" });
    assert.strictEqual(result[0].when, "true");
    assert.strictEqual(result[0].shell, "false");
  });

  // 1.14 ── Multiple valid asserts in one file ──────────────────────

  it("multiple valid asserts → all loaded", () => {
    clearGlobal();
    makeProject("multi", {
      local: {
        a: { hook: "tool_call", shell: "true" },
        b: { hook: "tool_call", filter: { toolName: "read" }, shell: "false" },
        c: { hook: "tool_call", filter: { toolName: "bash" }, shell: "grep x" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "multi"));
    assert.strictEqual(result.length, 3);
    const names = result.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ["a", "b", "c"]);
  });

  // ── Section-based tests ──────────────────────────────────────────

  // 1.15 ── Multiple sections ───────────────────────────────────────

  it("multiple sections → all loaded with correct source", () => {
    clearGlobal();
    makeProject("multi-section", {
      local: {
        "my-rule": { hook: "tool_call", shell: "false" },
      },
      "meffmadd/pi-assert-rules": {
        "block-write": { hook: "tool_call", shell: "false" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "multi-section"));
    assert.strictEqual(result.length, 2);

    const local = result.find((a) => a.source === "local")!;
    assert.strictEqual(local.name, "my-rule");

    const repo = result.find((a) => a.source === "meffmadd/pi-assert-rules")!;
    assert.strictEqual(repo.name, "block-write");
  });

  // 1.16 ── $schema key is ignored ──────────────────────────────────

  it("$schema key is ignored", () => {
    clearGlobal();
    makeProject("with-schema", {
      $schema: "https://example.com/schema.json",
      local: {
        "my-rule": { hook: "tool_call", shell: "false" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "with-schema"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "my-rule");
  });

  // 1.17 ── Project repo overrides global repo ──────────────────────

  it("project repo overrides global repo by source+name", () => {
    clearGlobal();
    makeGlobal({
      "meffmadd/pi-assert-rules": {
        "block-write": { hook: "tool_call", shell: "false" },
        "other-rule": { hook: "tool_call", shell: "true" },
      },
    });

    makeProject("repo-override", {
      "meffmadd/pi-assert-rules": {
        "block-write": { hook: "tool_call", shell: "exit 1" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "repo-override"));
    assert.strictEqual(result.length, 2);

    const overridden = result.find(
      (a) => a.name === "block-write",
    )!;
    assert.strictEqual(overridden.shell, "exit 1"); // project wins
    assert.strictEqual(overridden.source, "meffmadd/pi-assert-rules");

    const other = result.find((a) => a.name === "other-rule")!;
    assert.strictEqual(other.shell, "true"); // global passed through
  });

  // 1.18 ── Same name in different sections → both loaded ──────────

  it("same name, different source → both loaded", () => {
    clearGlobal();
    makeProject("name-collision", {
      local: {
        guard: { hook: "tool_call", shell: "false" },
      },
      "other/repo": {
        guard: { hook: "tool_call", shell: "true" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "name-collision"));
    assert.strictEqual(result.length, 2);

    const guards = result.filter((a) => a.name === "guard");
    assert.strictEqual(guards.length, 2);

    const sources = guards.map((a) => a.source).sort();
    assert.deepStrictEqual(sources, ["local", "other/repo"]);
  });

  // 1.19 ── Empty local section → skipped ──────────────────────────

  it("empty local section → skipped", () => {
    clearGlobal();
    makeProject("empty-local", {
      local: {},
      "other/repo": {
        rule: { hook: "tool_call", shell: "true" },
      },
    });

    const result = loadAsserts(join(tmpRoot, "empty-local"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].source, "other/repo");
  });

  // 1.20 ── Non-object top-level values → skipped ──────────────────

  it("non-object top-level values → skipped", () => {
    clearGlobal();
    makeProject("non-object-section", {
      local: {
        guard: { hook: "tool_call", shell: "true" },
      },
      bad: "not an object" as any,
    });

    const result = loadAsserts(join(tmpRoot, "non-object-section"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "guard");
  });

  // 1.21 ── repos array filters which sections are loaded ──────────

  it("repos array → only declared repo sections load", () => {
    clearGlobal();
    makeProject("repos-filter", {
      repos: ["repo/a"],
      local: { guard: { hook: "tool_call", shell: "true" } },
      "repo/a": { rule1: { hook: "tool_call", shell: "true" } },
      "repo/b": { rule2: { hook: "tool_call", shell: "true" } },
    });

    const result = loadAsserts(join(tmpRoot, "repos-filter"));
    // local + repo/a = 2 asserts, repo/b is ignored
    assert.strictEqual(result.length, 2);
    const names = result.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ["guard", "rule1"]);
  });

  // 1.22 ── Missing repos array → all sections load (backward compat)

  it("missing repos → all object sections loaded", () => {
    clearGlobal();
    makeProject("no-repos-array", {
      local: { guard: { hook: "tool_call", shell: "true" } },
      "repo/a": { rule1: { hook: "tool_call", shell: "true" } },
      "repo/b": { rule2: { hook: "tool_call", shell: "true" } },
    });

    const result = loadAsserts(join(tmpRoot, "no-repos-array"));
    assert.strictEqual(result.length, 3);
  });

  // 1.23 ── repos key itself is skipped (not a section) ───────────

  it("repos key is not treated as a section", () => {
    clearGlobal();
    makeProject("repos-not-section", {
      repos: ["repo/a"],
      local: { guard: { hook: "tool_call", shell: "true" } },
    });

    const result = loadAsserts(join(tmpRoot, "repos-not-section"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].source, "local");
  });
});
