/**
 * Tests that schema.json is a valid JSON Schema and that example
 * asserts.json files (both project .pi/asserts.json and the SKILL.md
 * examples) validate correctly.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

// ── Load the schema ────────────────────────────────────────────────

const schemaPath = join(import.meta.dirname!, "..", "schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

// ═══════════════════════════════════════════════════════════════════
// Schema validity
// ═══════════════════════════════════════════════════════════════════

describe("schema self-validation", () => {
  it("schema.json is valid JSON Schema (draft-07)", () => {
    assert.ok(validate);
  });
});

// ═══════════════════════════════════════════════════════════════════
// validate(config) → boolean
// ═══════════════════════════════════════════════════════════════════

describe("validate", () => {
  // ── Cases: [label, config, expected: boolean] ────────────────────

  type Case = [label: string, config: unknown, expected: boolean];

  const cases: Case[] = [
    // ── SKILL.md examples ──────────────────────────────────────────

    [
      "block all write tool calls",
      {
        local: {
          unmodified: {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
      true,
    ],

    [
      "guard specific file paths",
      {
        local: {
          "protect-env-files": {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -q \'\\.env\' && exit 1 || exit 0',
          },
        },
      },
      true,
    ],

    [
      "no secrets in env",
      {
        local: {
          "no-secrets-in-env": {
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -q SECRET_KEY <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      true,
    ],

    [
      "block rm -rf",
      {
        local: {
          "block-rm-rf": {
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -qE \'rm[[:space:]]+-rf\' <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      true,
    ],

    [
      "write only in src",
      {
        local: {
          "write-only-in-src": {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -q \'"path":"src/\' && exit 0 || exit 1',
          },
        },
      },
      true,
    ],

    [
      "no sensitive reads",
      {
        local: {
          "no-sensitive-reads": {
            hook: "tool_call",
            filter: { toolName: "read" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -qE \'\\.(env|pem|key)\' && exit 1 || exit 0',
          },
        },
      },
      true,
    ],

    [
      "default-based activation example",
      {
        local: {
          "always-active": {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
            default: true,
          },
          "opt-in": {
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: "false",
            default: false,
          },
        },
      },
      true,
    ],

    // ── Invalid configs ────────────────────────────────────────────

    [
      "missing required 'hook'",
      { local: { bad: { shell: "true" } } },
      false,
    ],

    [
      "missing required 'shell'",
      { local: { bad: { hook: "tool_call" } } },
      false,
    ],

    [
      "unknown property at assert level",
      {
        local: {
          bad: {
            hook: "tool_call",
            shell: "true",
            extraProp: "should not be here",
          },
        },
      },
      false,
    ],

    [
      "hook value not in enum",
      { local: { bad: { hook: "invalid_hook", shell: "true" } } },
      false,
    ],

    [
      "default is not boolean",
      {
        local: { bad: { hook: "tool_call", shell: "true", default: "yes" } },
      },
      false,
    ],

    [
      "top-level array rejected",
      [],
      false,
    ],

    [
      "top-level string rejected",
      "string",
      false,
    ],

    [
      "top-level null rejected",
      null,
      false,
    ],

    // ── Section-based validation ───────────────────────────────────

    [
      "accepts local section with valid asserts",
      { local: { guard: { hook: "tool_call", shell: "true" } } },
      true,
    ],

    [
      "accepts repo section with valid asserts",
      {
        "meffmadd/pi-assert-rules": {
          "block-write": { hook: "tool_call", shell: "false" },
        },
      },
      true,
    ],

    [
      "accepts mixed local and repo sections",
      {
        local: { custom: { hook: "tool_call", shell: "true" } },
        "some/repo": { installed: { hook: "tool_call", shell: "false" } },
      },
      true,
    ],

    [
      "accepts $schema alongside sections",
      {
        $schema: "https://example.com/schema.json",
        local: { guard: { hook: "tool_call", shell: "true" } },
      },
      true,
    ],

    [
      "accepts repos array with valid entries",
      {
        repos: ["meffmadd/pi-assert-rules"],
        local: { guard: { hook: "tool_call", shell: "true" } },
        "meffmadd/pi-assert-rules": {
          block: { hook: "tool_call", shell: "false" },
        },
      },
      true,
    ],

    [
      "repos must be an array",
      { repos: "not-an-array" },
      false,
    ],

    [
      "repos entries must be owner/repo format",
      { repos: ["no-slash"] },
      false,
    ],

    [
      "repos entries must be unique",
      { repos: ["a/b", "a/b"] },
      false,
    ],

    // ── Schema evolution ───────────────────────────────────────────

    [
      "accepts 'tool_call' as hook",
      { local: { guard: { hook: "tool_call", shell: "true" } } },
      true,
    ],

    [
      "rejects 'tool_result' as hook (not yet in enum)",
      { local: { guard: { hook: "tool_result", shell: "true" } } },
      false,
    ],
  ];

  // ── Run cases ────────────────────────────────────────────────────

  for (const [label, config, expected] of cases) {
    it(label, () => {
      assert.strictEqual(validate(config), expected);
    });
  }
});
