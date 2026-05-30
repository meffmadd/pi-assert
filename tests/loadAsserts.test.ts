/**
 * Tests for loadAsserts — config loading & merge.
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
  // Wipe any leftover project dir from a previous run
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

  // 1.2 ── Project-only file ───────────────────────────────────────

  it("project-only file → loads 1 assert", () => {
    clearGlobal();
    makeProject("proj-only", {
      unmodified: {
        hook: "tool_call",
        filter: { toolName: "write" },
        shell: "false",
      },
    });

    const result = loadAsserts(join(tmpRoot, "proj-only"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "unmodified");
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
      "no-secrets": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell: 'grep -q SECRET <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
      },
    });

    const result = loadAsserts(cwd);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "no-secrets");
    assert.strictEqual(result[0].hook, "tool_call");
    assert.deepStrictEqual(result[0].filter, { toolName: "bash" });
  });

  // 1.4 ── Project overrides global by key ─────────────────────────

  it("project overrides global by key name", () => {
    clearGlobal();
    makeGlobal({
      "no-secrets": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell: "grep -q SECRET",
      },
      "global-only": {
        hook: "tool_call",
        shell: "false",
      },
    });

    makeProject("proj-override", {
      "no-secrets": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell: "exit 0",
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
      "valid-one": { hook: "tool_call", shell: "true" },
      "no-hook": { shell: "true" },
      "no-shell": { hook: "tool_call" },
      "null-val": null as any,
    });

    const result = loadAsserts(join(tmpRoot, "invalid-entries"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "valid-one");
  });

  it("all entries invalid → []", () => {
    clearGlobal();
    makeProject("all-invalid", {
      x: { shell: "true" },
      y: { hook: "tool_call" },
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
      "catch-all": {
        hook: "tool_call",
        shell: "false",
      },
    });

    const result = loadAsserts(join(tmpRoot, "no-filter"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "catch-all");
    assert.strictEqual(result[0].filter, undefined);
  });

  // 1.9 ── Multiple valid asserts in one file ──────────────────────

  it("multiple valid asserts → all loaded", () => {
    clearGlobal();
    makeProject("multi", {
      a: { hook: "tool_call", shell: "true" },
      b: { hook: "tool_call", filter: { toolName: "read" }, shell: "false" },
      c: { hook: "tool_call", filter: { toolName: "bash" }, shell: "grep x" },
    });

    const result = loadAsserts(join(tmpRoot, "multi"));
    assert.strictEqual(result.length, 3);
    const names = result.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ["a", "b", "c"]);
  });
});
