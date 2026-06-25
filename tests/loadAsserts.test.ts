/**
 * Tests for loadAsserts — config loading & merge with sectioned format.
 *
 * Usage: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
  AssertsParseError,
  loadAsserts,
  type Assert,
} from "../pi-assert/engine.js";

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

/** Write asserts.json to HOME/.pi (global). */
function makeGlobal(json: object) {
  mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
  writeFileSync(join(tmpRoot, ".pi", "asserts.json"), JSON.stringify(json, null, 2));
}

/** Create a case working directory, optionally writing asserts.json. */
function setupCwd(index: number, json?: object): string {
  const dir = join(tmpRoot, `case-${index}`);
  mkdirSync(dir, { recursive: true });
  if (json !== undefined) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "asserts.json"), JSON.stringify(json));
  }
  return dir;
}

// ═══════════════════════════════════════════════════════════════════
// loadAsserts
// ═══════════════════════════════════════════════════════════════════

describe("loadAsserts", () => {

  type Case = {
    label: string;
    projectJson?: Record<string, unknown>;
    globalJson?: Record<string, unknown>;
    expected: Assert[];
  };

  const cases: Case[] = [
    // 1.1 ── Empty state (no files)
    {
      label: "empty state — no files exist → []",
      expected: [],
    },

    // 1.2 ── Project-only file (local section)
    {
      label: "project-only file (local) → loads 1 assert",
      projectJson: {
        local: {
          unmodified: {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
      expected: [
        {
          name: "unmodified",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: { toolName: "write" },
          when: undefined,
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.3 ── Global-only file
    {
      label: "global-only file → loads 1 assert",
      globalJson: {
        local: {
          "no-secrets": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -q SECRET <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      expected: [
        {
          name: "no-secrets",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: { toolName: "bash" },
          when: undefined,
          shell: 'grep -q SECRET <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          default: false,
        },
      ],
    },

    // 1.4 ── Project overrides global by source+name
    {
      label: "project overrides global by source+name",
      projectJson: {
        local: {
          "no-secrets": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: "exit 0",
          },
        },
      },
      globalJson: {
        local: {
          "no-secrets": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: "grep -q SECRET",
          },
          "global-only": {
            description: "d",
            hook: "tool_call",
            shell: "false",
          },
        },
      },
      expected: [
        {
          name: "no-secrets",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: { toolName: "bash" },
          when: undefined,
          shell: "exit 0",
          default: false,
        },
        {
          name: "global-only",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.5 ── Invalid entries silently skipped
    {
      label: "invalid entries = silently skipped",
      projectJson: {
        local: {
          "valid-one": { description: "d", hook: "tool_call", shell: "true" },
          "no-hook": { shell: "true" },
          "no-shell": { description: "d", hook: "tool_call" },
          "null-val": null,
        },
      } as Record<string, unknown>,
      expected: [
        {
          name: "valid-one",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    {
      label: "all entries invalid → []",
      projectJson: {
        local: {
          x: { shell: "true" },
          y: { description: "d", hook: "tool_call" },
        },
      },
      expected: [],
    },

    // 1.6 ── Empty JSON object → []
    {
      label: "empty json object → []",
      projectJson: {},
      expected: [],
    },

    // 1.8 ── Assert without filter → filter is undefined
    {
      label: "assert without filter → filter is undefined",
      projectJson: {
        local: {
          "catch-all": {
            description: "d",
            hook: "tool_call",
            shell: "false",
          },
        },
      },
      expected: [
        {
          name: "catch-all",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.9 ── default: true
    {
      label: "default: true in JSON → Assert.default = true",
      projectJson: {
        local: {
          guard: {
            description: "d",
            hook: "tool_call",
            shell: "false",
            default: true,
          },
        },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: true,
        },
      ],
    },

    // 1.10 ── default: false
    {
      label: "default: false in JSON → Assert.default = false",
      projectJson: {
        local: {
          guard: {
            description: "d",
            hook: "tool_call",
            shell: "false",
            default: false,
          },
        },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.11 ── default omitted → false
    {
      label: "default omitted → Assert.default = false",
      projectJson: {
        local: {
          guard: {
            description: "d",
            hook: "tool_call",
            shell: "false",
          },
        },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.12 ── Mixed defaults
    {
      label: "mixed defaults → each assert gets its own default value",
      projectJson: {
        local: {
          active: { description: "d", hook: "tool_call", shell: "false", default: true },
          inactive: { description: "d", hook: "tool_call", shell: "true", default: false },
          unspecified: { description: "d", hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "active",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: true,
        },
        {
          name: "inactive",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "unspecified",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    // 1.13 ── when field (precondition)
    {
      label: "when field present → Assert.when is the string",
      projectJson: {
        local: {
          conditional: {
            description: "d",
            hook: "tool_call",
            shell: "false",
            when: '[ "$PI_TOOL_NAME" = write ]',
          },
        },
      },
      expected: [
        {
          name: "conditional",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: '[ "$PI_TOOL_NAME" = write ]',
          shell: "false",
          default: false,
        },
      ],
    },

    {
      label: "when field absent → Assert.when is undefined",
      projectJson: {
        local: {
          simple: {
            description: "d",
            hook: "tool_call",
            shell: "true",
          },
        },
      },
      expected: [
        {
          name: "simple",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    {
      label: "when field alongside filter → both loaded",
      projectJson: {
        local: {
          guarded: {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "bash" },
            when: "true",
            shell: "false",
          },
        },
      },
      expected: [
        {
          name: "guarded",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: { toolName: "bash" },
          when: "true",
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.24 ── agent_end hook loaded correctly
    {
      label: "agent_end hook → loaded with correct hook value",
      projectJson: {
        local: {
          "check-git-clean": {
            description: "d",
            hook: "agent_end",
            shell: "git diff --quiet",
            default: true,
          },
        },
      },
      expected: [
        {
          name: "check-git-clean",
          source: "local",
          description: "d",
          hook: "agent_end",
          filter: undefined,
          when: undefined,
          shell: "git diff --quiet",
          default: true,
        },
      ],
    },

    {
      label: "agent_end with filter, when, and default",
      projectJson: {
        local: {
          "check-tests": {
            description: "d",
            hook: "agent_end",
            filter: { event: "agent_end" },
            when: "test -d tests",
            shell: "test -n \"$(ls tests/*.test.ts 2>/dev/null)\"",
            default: false,
          },
        },
      },
      expected: [
        {
          name: "check-tests",
          source: "local",
          description: "d",
          hook: "agent_end",
          filter: { event: "agent_end" },
          when: "test -d tests",
          shell: "test -n \"$(ls tests/*.test.ts 2>/dev/null)\"",
          default: false,
        },
      ],
    },

    // 1.25 ── Mixed hooks in same file
    {
      label: "mixed hooks in same file → all loaded",
      projectJson: {
        local: {
          "tool-guard": {
            description: "d",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
          "end-guard": {
            description: "d",
            hook: "agent_end",
            shell: "git diff --quiet",
            default: true,
          },
        },
      },
      expected: [
        {
          name: "tool-guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: { toolName: "write" },
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "end-guard",
          source: "local",
          description: "d",
          hook: "agent_end",
          filter: undefined,
          when: undefined,
          shell: "git diff --quiet",
          default: true,
        },
      ],
    },

    // 1.14 ── Multiple valid asserts in one file
    {
      label: "multiple valid asserts → all loaded",
      projectJson: {
        local: {
          a: { description: "d", hook: "tool_call", shell: "true" },
          b: { description: "d", hook: "tool_call", filter: { toolName: "read" }, shell: "false" },
          c: { description: "d", hook: "tool_call", filter: { toolName: "bash" }, shell: "grep x" },
        },
      },
      expected: [
        {
          name: "a",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "b",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: { toolName: "read" },
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "c",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: { toolName: "bash" },
          when: undefined,
          shell: "grep x",
          default: false,
        },
      ],
    },

    // 1.15 ── Multiple sections
    {
      label: "multiple sections → all loaded with correct source",
      projectJson: {
        local: {
          "my-rule": { description: "d", hook: "tool_call", shell: "false" },
        },
        "meffmadd/pi-assert-rules": {
          "block-write": { description: "d", hook: "tool_call", shell: "false" },
        },
      },
      expected: [
        {
          name: "my-rule",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "block-write",
          source: "meffmadd/pi-assert-rules",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.16 ── $schema key is ignored
    {
      label: "$schema key is ignored",
      projectJson: {
        $schema: "https://example.com/schema.json",
        local: {
          "my-rule": { description: "d", hook: "tool_call", shell: "false" },
        },
      },
      expected: [
        {
          name: "my-rule",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
      ],
    },

    // 1.17 ── Project repo overrides global repo
    {
      label: "project repo overrides global repo by source+name",
      projectJson: {
        "meffmadd/pi-assert-rules": {
          "block-write": { description: "d", hook: "tool_call", shell: "exit 1" },
        },
      },
      globalJson: {
        "meffmadd/pi-assert-rules": {
          "block-write": { description: "d", hook: "tool_call", shell: "false" },
          "other-rule": { description: "d", hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "block-write",
          source: "meffmadd/pi-assert-rules",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "exit 1",
          default: false,
        },
        {
          name: "other-rule",
          source: "meffmadd/pi-assert-rules",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    // 1.18 ── Same name in different sections → both loaded
    {
      label: "same name, different source → both loaded",
      projectJson: {
        local: {
          guard: { description: "d", hook: "tool_call", shell: "false" },
        },
        "other/repo": {
          guard: { description: "d", hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "guard",
          source: "other/repo",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    // 1.19 ── Empty local section → skipped
    {
      label: "empty local section → skipped",
      projectJson: {
        local: {},
        "other/repo": {
          rule: { description: "d", hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "rule",
          source: "other/repo",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    // 1.20 ── Non-object top-level values → skipped
    {
      label: "non-object top-level values → skipped",
      projectJson: {
        local: {
          guard: { description: "d", hook: "tool_call", shell: "true" },
        },
        bad: "not an object",
      } as Record<string, unknown>,
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    // 1.21 ── repos array filters which sections are loaded
    {
      label: "repos array → only declared repo sections load",
      projectJson: {
        repos: ["repo/a"],
        local: { guard: { description: "d", hook: "tool_call", shell: "true" } },
        "repo/a": { rule1: { description: "d", hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { description: "d", hook: "tool_call", shell: "true" } },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "rule1",
          source: "repo/a",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    // 1.22 ── Missing repos array → all sections load (backward compat)
    {
      label: "missing repos → all object sections loaded",
      projectJson: {
        local: { guard: { description: "d", hook: "tool_call", shell: "true" } },
        "repo/a": { rule1: { description: "d", hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { description: "d", hook: "tool_call", shell: "true" } },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "rule1",
          source: "repo/a",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "rule2",
          source: "repo/b",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },

    // 1.23 ── repos key itself is skipped (not a section)
    {
      label: "repos key is not treated as a section",
      projectJson: {
        repos: ["repo/a"],
        local: { guard: { description: "d", hook: "tool_call", shell: "true" } },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          description: "d",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
      ],
    },
  ];

  // ── Run cases ────────────────────────────────────────────────────

  for (const [i, { label, projectJson, globalJson, expected }] of cases.entries()) {
    it(label, () => {
      clearGlobal();
      if (globalJson !== undefined) makeGlobal(globalJson);
      const cwd = setupCwd(i, projectJson);
      // Strip the engine-internal `path` field so the table stays focused
      // on the user-visible assertion shape.  Provenance is covered by
      // the dedicated `loadAsserts — Assert.path provenance` suite below.
      const actual = loadAsserts(cwd).map(({ path: _path, ...rest }) => rest);
      assert.deepStrictEqual(actual, expected);
    });
  }

  // ── Standalone: malformed JSON throws ────────────────────────────

  it("malformed project JSON → throws AssertsParseError pointing at project file", () => {
    clearGlobal();
    const dir = join(tmpRoot, "malformed-project");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "asserts.json"), "{broken");

    let caught: unknown;
    try {
      loadAsserts(dir);
    } catch (err) {
      caught = err;
    }

    assert.ok(
      caught instanceof AssertsParseError,
      `expected AssertsParseError, got ${caught}`,
    );
    const e = caught as AssertsParseError;
    assert.strictEqual(e.errors.length, 1);
    assert.strictEqual(e.errors[0].path, join(dir, ".pi", "asserts.json"));
    assert.match(e.errors[0].reason, /JSON|JSON|token|position|end/i);
  });

  it("malformed global JSON + valid project → throws with one error (global) and project asserts are not loaded", () => {
    clearGlobal();
    // Global is broken
    mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
    writeFileSync(join(tmpRoot, ".pi", "asserts.json"), "{broken");

    // Project is valid
    const dir = join(tmpRoot, "global-broken");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "asserts.json"),
      JSON.stringify({
        local: { guard: { description: "d", hook: "tool_call", shell: "true" } },
      }),
    );

    let caught: unknown;
    try {
      loadAsserts(dir);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof AssertsParseError);
    const e = caught as AssertsParseError;
    assert.strictEqual(e.errors.length, 1);
    assert.strictEqual(
      e.errors[0].path,
      join(homedir(), ".pi", "asserts.json"),
    );
  });

  it("malformed project JSON + valid global → throws with one error (project) and global asserts are not loaded", () => {
    // Valid global
    mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpRoot, ".pi", "asserts.json"),
      JSON.stringify({
        local: { "global-rule": { description: "d", hook: "tool_call", shell: "true" } },
      }),
    );

    // Broken project
    const dir = join(tmpRoot, "project-broken");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "asserts.json"), "{broken");

    let caught: unknown;
    try {
      loadAsserts(dir);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof AssertsParseError);
    const e = caught as AssertsParseError;
    assert.strictEqual(e.errors.length, 1);
    assert.strictEqual(e.errors[0].path, join(dir, ".pi", "asserts.json"));
  });

  it("both files malformed → throws with two errors", () => {
    mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
    writeFileSync(join(tmpRoot, ".pi", "asserts.json"), "{broken-global");

    const dir = join(tmpRoot, "both-broken");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "asserts.json"), "{broken-project");

    let caught: unknown;
    try {
      loadAsserts(dir);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof AssertsParseError);
    const e = caught as AssertsParseError;
    assert.strictEqual(e.errors.length, 2);
    const paths = new Set(e.errors.map((er) => er.path));
    assert.deepStrictEqual(paths, new Set([
      join(dir, ".pi", "asserts.json"),
      join(homedir(), ".pi", "asserts.json"),
    ]));
  });

  it("empty file → throws AssertsParseError", () => {
    clearGlobal();
    const dir = join(tmpRoot, "empty");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "asserts.json"), "");

    assert.throws(() => loadAsserts(dir), AssertsParseError);
  });
});

// ═══════════════════════════════════════════════════════════════════
// `Assert.path` provenance — every loaded assert carries the absolute
// path of the asserts.json file it came from.  The toggle UI uses this
// to write `default` flags back to the correct file.
// ═══════════════════════════════════════════════════════════════════

describe("loadAsserts — Assert.path provenance", () => {
  const globalPath = () => join(tmpRoot, ".pi", "asserts.json");
  const projectPath = (dir: string) => join(dir, ".pi", "asserts.json");

  it("no asserts loaded → empty array, no path leakage", () => {
    clearGlobal();
    const dir = join(tmpRoot, "path-empty");
    mkdirSync(dir, { recursive: true });
    const asserts = loadAsserts(dir);
    assert.deepStrictEqual(asserts, []);
  });

  it("project-only entry carries the project file path", () => {
    clearGlobal();
    const dir = join(tmpRoot, "path-project-only");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      projectPath(dir),
      JSON.stringify({
        local: { guard: { description: "d", hook: "tool_call", shell: "false" } },
      }),
    );

    const asserts = loadAsserts(dir);
    assert.strictEqual(asserts.length, 1);
    assert.strictEqual(asserts[0]?.path, projectPath(dir));
  });

  it("global-only entry carries the global file path", () => {
    clearGlobal();
    makeGlobal({
      local: { "g-rule": { description: "d", hook: "tool_call", shell: "true" } },
    });
    const dir = join(tmpRoot, "path-global-only");
    mkdirSync(dir, { recursive: true });

    const asserts = loadAsserts(dir);
    assert.strictEqual(asserts.length, 1);
    assert.strictEqual(asserts[0]?.path, globalPath());
  });

  it("project overrides global: override keeps the project path, sibling keeps the global path", () => {
    clearGlobal();
    makeGlobal({
      local: {
        shared: { description: "d", hook: "tool_call", shell: "global-shell" },
        "g-only": { description: "d", hook: "tool_call", shell: "g" },
      },
    });
    const dir = join(tmpRoot, "path-override");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      projectPath(dir),
      JSON.stringify({
        local: {
          shared: { description: "d", hook: "tool_call", shell: "project-shell" },
        },
      }),
    );

    const asserts = loadAsserts(dir);
    const shared = asserts.find((a) => a.name === "shared");
    const gOnly = asserts.find((a) => a.name === "g-only");
    assert.strictEqual(shared?.path, projectPath(dir));
    assert.strictEqual(gOnly?.path, globalPath());
  });

  it("$schema and repos are not exposed as asserts (no spurious path entries)", () => {
    clearGlobal();
    const dir = join(tmpRoot, "path-skip-meta");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      projectPath(dir),
      JSON.stringify({
        $schema: "https://example.com/schema.json",
        repos: ["owner/repo"],
        local: { rule: { description: "d", hook: "tool_call", shell: "true" } },
      }),
    );

    const asserts = loadAsserts(dir);
    assert.strictEqual(asserts.length, 1);
    assert.strictEqual(asserts[0]?.name, "rule");
    assert.strictEqual(asserts[0]?.path, projectPath(dir));
  });

  it("same name in different sources stays distinct (no path collisions)", () => {
    clearGlobal();
    const dir = join(tmpRoot, "path-distinct-sources");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      projectPath(dir),
      JSON.stringify({
        local: { guard: { description: "d", hook: "tool_call", shell: "false" } },
        "other/repo": { guard: { description: "d", hook: "tool_call", shell: "true" } },
      }),
    );

    const asserts = loadAsserts(dir);
    assert.strictEqual(asserts.length, 2);
    for (const a of asserts) {
      assert.strictEqual(a.path, projectPath(dir));
      assert.strictEqual(a.name, "guard");
    }
    // sanity: the two records are actually different sources
    const sources = new Set(asserts.map((a) => a.source));
    assert.strictEqual(sources.size, 2);
  });
});
