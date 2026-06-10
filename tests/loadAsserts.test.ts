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
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: "exit 0",
          },
        },
      },
      globalJson: {
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
      },
      expected: [
        {
          name: "no-secrets",
          source: "local",
          hook: "tool_call",
          filter: { toolName: "bash" },
          when: undefined,
          shell: "exit 0",
          default: false,
        },
        {
          name: "global-only",
          source: "local",
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
          "valid-one": { hook: "tool_call", shell: "true" },
          "no-hook": { shell: "true" },
          "no-shell": { hook: "tool_call" },
          "null-val": null,
        },
      } as Record<string, unknown>,
      expected: [
        {
          name: "valid-one",
          source: "local",
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
          y: { hook: "tool_call" },
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
            hook: "tool_call",
            shell: "false",
          },
        },
      },
      expected: [
        {
          name: "catch-all",
          source: "local",
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
            hook: "tool_call",
            shell: "false",
          },
        },
      },
      expected: [
        {
          name: "guard",
          source: "local",
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
          active: { hook: "tool_call", shell: "false", default: true },
          inactive: { hook: "tool_call", shell: "true", default: false },
          unspecified: { hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "active",
          source: "local",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: true,
        },
        {
          name: "inactive",
          source: "local",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "unspecified",
          source: "local",
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
            hook: "tool_call",
            shell: "true",
          },
        },
      },
      expected: [
        {
          name: "simple",
          source: "local",
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
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
          "end-guard": {
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
          hook: "tool_call",
          filter: { toolName: "write" },
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "end-guard",
          source: "local",
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
          a: { hook: "tool_call", shell: "true" },
          b: { hook: "tool_call", filter: { toolName: "read" }, shell: "false" },
          c: { hook: "tool_call", filter: { toolName: "bash" }, shell: "grep x" },
        },
      },
      expected: [
        {
          name: "a",
          source: "local",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "b",
          source: "local",
          hook: "tool_call",
          filter: { toolName: "read" },
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "c",
          source: "local",
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
          "my-rule": { hook: "tool_call", shell: "false" },
        },
        "meffmadd/pi-assert-rules": {
          "block-write": { hook: "tool_call", shell: "false" },
        },
      },
      expected: [
        {
          name: "my-rule",
          source: "local",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "block-write",
          source: "meffmadd/pi-assert-rules",
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
          "my-rule": { hook: "tool_call", shell: "false" },
        },
      },
      expected: [
        {
          name: "my-rule",
          source: "local",
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
          "block-write": { hook: "tool_call", shell: "exit 1" },
        },
      },
      globalJson: {
        "meffmadd/pi-assert-rules": {
          "block-write": { hook: "tool_call", shell: "false" },
          "other-rule": { hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "block-write",
          source: "meffmadd/pi-assert-rules",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "exit 1",
          default: false,
        },
        {
          name: "other-rule",
          source: "meffmadd/pi-assert-rules",
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
          guard: { hook: "tool_call", shell: "false" },
        },
        "other/repo": {
          guard: { hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "false",
          default: false,
        },
        {
          name: "guard",
          source: "other/repo",
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
          rule: { hook: "tool_call", shell: "true" },
        },
      },
      expected: [
        {
          name: "rule",
          source: "other/repo",
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
          guard: { hook: "tool_call", shell: "true" },
        },
        bad: "not an object",
      } as Record<string, unknown>,
      expected: [
        {
          name: "guard",
          source: "local",
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
        local: { guard: { hook: "tool_call", shell: "true" } },
        "repo/a": { rule1: { hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { hook: "tool_call", shell: "true" } },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "rule1",
          source: "repo/a",
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
        local: { guard: { hook: "tool_call", shell: "true" } },
        "repo/a": { rule1: { hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { hook: "tool_call", shell: "true" } },
      },
      expected: [
        {
          name: "guard",
          source: "local",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "rule1",
          source: "repo/a",
          hook: "tool_call",
          filter: undefined,
          when: undefined,
          shell: "true",
          default: false,
        },
        {
          name: "rule2",
          source: "repo/b",
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
        local: { guard: { hook: "tool_call", shell: "true" } },
      },
      expected: [
        {
          name: "guard",
          source: "local",
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
      assert.deepStrictEqual(loadAsserts(cwd), expected);
    });
  }

  // ── Standalone: malformed JSON throws ────────────────────────────

  it("malformed JSON → throws", () => {
    clearGlobal();
    const dir = join(tmpRoot, "malformed");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "asserts.json"), "{broken");

    assert.throws(() => loadAsserts(dir));
  });
});
