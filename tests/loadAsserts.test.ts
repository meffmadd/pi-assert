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

  // ── Cases: [label, projectJson?, globalJson?, expected: Assert[]] ─

  type Case = [
    label: string,
    projectJson: Record<string, unknown> | undefined,
    globalJson: Record<string, unknown> | undefined,
    expected: Assert[],
  ];

  const cases: Case[] = [
    // 1.1 ── Empty state (no files)
    [
      "empty state — no files exist → []",
      undefined,
      undefined,
      [],
    ],

    // 1.2 ── Project-only file (local section)
    [
      "project-only file (local) → loads 1 assert",
      {
        local: {
          unmodified: {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
      undefined,
      [
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
    ],

    // 1.3 ── Global-only file
    [
      "global-only file → loads 1 assert",
      undefined,
      {
        local: {
          "no-secrets": {
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -q SECRET <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      [
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
    ],

    // 1.4 ── Project overrides global by source+name
    [
      "project overrides global by source+name",
      {
        local: {
          "no-secrets": {
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: "exit 0",
          },
        },
      },
      {
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
      [
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
    ],

    // 1.5 ── Invalid entries silently skipped
    [
      "invalid entries = silently skipped",
      {
        local: {
          "valid-one": { hook: "tool_call", shell: "true" },
          "no-hook": { shell: "true" },
          "no-shell": { hook: "tool_call" },
          "null-val": null,
        },
      } as Record<string, unknown>,
      undefined,
      [
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
    ],

    [
      "all entries invalid → []",
      {
        local: {
          x: { shell: "true" },
          y: { hook: "tool_call" },
        },
      },
      undefined,
      [],
    ],

    // 1.6 ── Empty JSON object → []
    [
      "empty json object → []",
      {},
      undefined,
      [],
    ],

    // 1.8 ── Assert without filter → filter is undefined
    [
      "assert without filter → filter is undefined",
      {
        local: {
          "catch-all": {
            hook: "tool_call",
            shell: "false",
          },
        },
      },
      undefined,
      [
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
    ],

    // 1.9 ── default: true
    [
      "default: true in JSON → Assert.default = true",
      {
        local: {
          guard: {
            hook: "tool_call",
            shell: "false",
            default: true,
          },
        },
      },
      undefined,
      [
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
    ],

    // 1.10 ── default: false
    [
      "default: false in JSON → Assert.default = false",
      {
        local: {
          guard: {
            hook: "tool_call",
            shell: "false",
            default: false,
          },
        },
      },
      undefined,
      [
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
    ],

    // 1.11 ── default omitted → false
    [
      "default omitted → Assert.default = false",
      {
        local: {
          guard: {
            hook: "tool_call",
            shell: "false",
          },
        },
      },
      undefined,
      [
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
    ],

    // 1.12 ── Mixed defaults
    [
      "mixed defaults → each assert gets its own default value",
      {
        local: {
          active: { hook: "tool_call", shell: "false", default: true },
          inactive: { hook: "tool_call", shell: "true", default: false },
          unspecified: { hook: "tool_call", shell: "true" },
        },
      },
      undefined,
      [
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
    ],

    // 1.13 ── when field (precondition)
    [
      "when field present → Assert.when is the string",
      {
        local: {
          conditional: {
            hook: "tool_call",
            shell: "false",
            when: '[ "$PI_TOOL_NAME" = write ]',
          },
        },
      },
      undefined,
      [
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
    ],

    [
      "when field absent → Assert.when is undefined",
      {
        local: {
          simple: {
            hook: "tool_call",
            shell: "true",
          },
        },
      },
      undefined,
      [
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
    ],

    [
      "when field alongside filter → both loaded",
      {
        local: {
          guarded: {
            hook: "tool_call",
            filter: { toolName: "bash" },
            when: "true",
            shell: "false",
          },
        },
      },
      undefined,
      [
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
    ],

    // 1.14 ── Multiple valid asserts in one file
    [
      "multiple valid asserts → all loaded",
      {
        local: {
          a: { hook: "tool_call", shell: "true" },
          b: { hook: "tool_call", filter: { toolName: "read" }, shell: "false" },
          c: { hook: "tool_call", filter: { toolName: "bash" }, shell: "grep x" },
        },
      },
      undefined,
      [
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
    ],

    // 1.15 ── Multiple sections
    [
      "multiple sections → all loaded with correct source",
      {
        local: {
          "my-rule": { hook: "tool_call", shell: "false" },
        },
        "meffmadd/pi-assert-rules": {
          "block-write": { hook: "tool_call", shell: "false" },
        },
      },
      undefined,
      [
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
    ],

    // 1.16 ── $schema key is ignored
    [
      "$schema key is ignored",
      {
        $schema: "https://example.com/schema.json",
        local: {
          "my-rule": { hook: "tool_call", shell: "false" },
        },
      },
      undefined,
      [
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
    ],

    // 1.17 ── Project repo overrides global repo
    [
      "project repo overrides global repo by source+name",
      {
        "meffmadd/pi-assert-rules": {
          "block-write": { hook: "tool_call", shell: "exit 1" },
        },
      },
      {
        "meffmadd/pi-assert-rules": {
          "block-write": { hook: "tool_call", shell: "false" },
          "other-rule": { hook: "tool_call", shell: "true" },
        },
      },
      [
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
    ],

    // 1.18 ── Same name in different sections → both loaded
    [
      "same name, different source → both loaded",
      {
        local: {
          guard: { hook: "tool_call", shell: "false" },
        },
        "other/repo": {
          guard: { hook: "tool_call", shell: "true" },
        },
      },
      undefined,
      [
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
    ],

    // 1.19 ── Empty local section → skipped
    [
      "empty local section → skipped",
      {
        local: {},
        "other/repo": {
          rule: { hook: "tool_call", shell: "true" },
        },
      },
      undefined,
      [
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
    ],

    // 1.20 ── Non-object top-level values → skipped
    [
      "non-object top-level values → skipped",
      {
        local: {
          guard: { hook: "tool_call", shell: "true" },
        },
        bad: "not an object",
      } as Record<string, unknown>,
      undefined,
      [
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
    ],

    // 1.21 ── repos array filters which sections are loaded
    [
      "repos array → only declared repo sections load",
      {
        repos: ["repo/a"],
        local: { guard: { hook: "tool_call", shell: "true" } },
        "repo/a": { rule1: { hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { hook: "tool_call", shell: "true" } },
      },
      undefined,
      [
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
    ],

    // 1.22 ── Missing repos array → all sections load (backward compat)
    [
      "missing repos → all object sections loaded",
      {
        local: { guard: { hook: "tool_call", shell: "true" } },
        "repo/a": { rule1: { hook: "tool_call", shell: "true" } },
        "repo/b": { rule2: { hook: "tool_call", shell: "true" } },
      },
      undefined,
      [
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
    ],

    // 1.23 ── repos key itself is skipped (not a section)
    [
      "repos key is not treated as a section",
      {
        repos: ["repo/a"],
        local: { guard: { hook: "tool_call", shell: "true" } },
      },
      undefined,
      [
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
    ],
  ];

  // ── Run cases ────────────────────────────────────────────────────

  for (const [i, [label, projectJson, globalJson, expected]] of cases.entries()) {
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
