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
  type Case = { label: string; config: unknown; expected: boolean };

  const cases: Case[] = [
    // ── SKILL.md examples ──────────────────────────────────────────

    {
      label: "block all write tool calls",
      config: {
        local: {
          unmodified: {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
      expected: true,
    },

    {
      label: "guard specific file paths",
      config: {
        local: {
          "protect-env-files": {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -q \'\\.env\' && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "no secrets in env",
      config: {
        local: {
          "no-secrets-in-env": {
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -q SECRET_KEY <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "block rm -rf",
      config: {
        local: {
          "block-rm-rf": {
            hook: "tool_call",
            filter: { toolName: "bash" },
            shell: 'grep -qE \'rm[[:space:]]+-rf\' <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "write only in src",
      config: {
        local: {
          "write-only-in-src": {
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -q \'"path":"src/\' && exit 0 || exit 1',
          },
        },
      },
      expected: true,
    },

    {
      label: "no sensitive reads",
      config: {
        local: {
          "no-sensitive-reads": {
            hook: "tool_call",
            filter: { toolName: "read" },
            shell: 'echo "$PI_TOOL_INPUT" | grep -qE \'\\.(env|pem|key)\' && exit 1 || exit 0',
          },
        },
      },
      expected: true,
    },

    {
      label: "default-based activation example",
      config: {
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
      expected: true,
    },

    // ── Invalid configs ────────────────────────────────────────────

    {
      label: "missing required 'hook'",
      config: { local: { bad: { shell: "true" } } },
      expected: false,
    },

    {
      label: "missing required 'shell'",
      config: { local: { bad: { hook: "tool_call" } } },
      expected: false,
    },

    {
      label: "unknown property at assert level",
      config: {
        local: {
          bad: {
            hook: "tool_call",
            shell: "true",
            extraProp: "should not be here",
          },
        },
      },
      expected: false,
    },

    {
      label: "hook value not in enum",
      config: { local: { bad: { hook: "invalid_hook", shell: "true" } } },
      expected: false,
    },

    {
      label: "default is not boolean",
      config: {
        local: { bad: { hook: "tool_call", shell: "true", default: "yes" } },
      },
      expected: false,
    },

    {
      label: "top-level array rejected",
      config: [],
      expected: false,
    },

    {
      label: "top-level string rejected",
      config: "string",
      expected: false,
    },

    {
      label: "top-level null rejected",
      config: null,
      expected: false,
    },

    // ── Section-based validation ───────────────────────────────────

    {
      label: "accepts local section with valid asserts",
      config: { local: { guard: { hook: "tool_call", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts repo section with valid asserts",
      config: {
        "meffmadd/pi-assert-rules": {
          "block-write": { hook: "tool_call", shell: "false" },
        },
      },
      expected: true,
    },

    {
      label: "accepts mixed local and repo sections",
      config: {
        local: { custom: { hook: "tool_call", shell: "true" } },
        "some/repo": { installed: { hook: "tool_call", shell: "false" } },
      },
      expected: true,
    },

    {
      label: "accepts $schema alongside sections",
      config: {
        $schema: "https://example.com/schema.json",
        local: { guard: { hook: "tool_call", shell: "true" } },
      },
      expected: true,
    },

    {
      label: "accepts repos array with valid entries",
      config: {
        repos: ["meffmadd/pi-assert-rules"],
        local: { guard: { hook: "tool_call", shell: "true" } },
        "meffmadd/pi-assert-rules": {
          block: { hook: "tool_call", shell: "false" },
        },
      },
      expected: true,
    },

    {
      label: "repos must be an array",
      config: { repos: "not-an-array" },
      expected: false,
    },

    {
      label: "repos entries must be owner/repo format",
      config: { repos: ["no-slash"] },
      expected: false,
    },

    {
      label: "repos entries must be unique",
      config: { repos: ["a/b", "a/b"] },
      expected: false,
    },

    // ── Schema evolution ───────────────────────────────────────────

    {
      label: "accepts 'tool_call' as hook",
      config: { local: { guard: { hook: "tool_call", shell: "true" } } },
      expected: true,
    },

    {
      label: "accepts 'tool_result' as hook",
      config: { local: { guard: { hook: "tool_result", shell: "true" } } },
      expected: true,
    },

    {
      label: "tool_result with filter and when",
      config: {
        local: {
          "block-secrets-in-reads": {
            hook: "tool_result",
            filter: { toolName: "read" },
            shell: "grep -qE 'SECRET' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
            when: "true",
            default: false,
          },
        },
      },
      expected: true,
    },

    {
      label: "rejects 'session_shutdown' as hook (not in enum)",
      config: { local: { guard: { hook: "session_shutdown", shell: "true" } } },
      expected: false,
    },

    {
      label: "accepts 'agent_end' as hook",
      config: { local: { guard: { hook: "agent_end", shell: "true" } } },
      expected: true,
    },

    {
      label: "agent_end with when and default",
      config: {
        local: {
          "check-git-clean": {
            hook: "agent_end",
            shell: "git diff --quiet",
            when: "test -d .git",
            default: true,
          },
        },
      },
      expected: true,
    },
  ];

  for (const { label, config, expected } of cases) {
    it(label, () => {
      assert.strictEqual(validate(config), expected);
    });
  }
});
