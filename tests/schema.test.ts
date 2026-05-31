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
    // Compiling would have thrown if the schema itself was invalid.
    // ajv.compile runs meta-validation internally.
    assert.ok(validate);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SKILL.md examples
// ═══════════════════════════════════════════════════════════════════

describe("SKILL.md examples", () => {
  it("block all write tool calls", () => {
    const cfg = {
      unmodified: {
        hook: "tool_call",
        filter: { toolName: "write" },
        shell: "false",
      },
    };
    assert.ok(validate(cfg), ajv.errorsText(validate.errors));
  });

  it("guard specific file paths", () => {
    const cfg = {
      "protect-env-files": {
        hook: "tool_call",
        filter: { toolName: "write" },
        shell:
          'echo "$PI_TOOL_INPUT" | grep -q \'\\.env\' && exit 1 || exit 0',
      },
    };
    assert.ok(validate(cfg), ajv.errorsText(validate.errors));
  });

  it("no secrets in env", () => {
    const cfg = {
      "no-secrets-in-env": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell:
          'grep -q SECRET_KEY <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
      },
    };
    assert.ok(validate(cfg), ajv.errorsText(validate.errors));
  });

  it("block rm -rf", () => {
    const cfg = {
      "block-rm-rf": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell:
          'grep -qE \'rm[[:space:]]+-rf\' <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
      },
    };
    assert.ok(validate(cfg), ajv.errorsText(validate.errors));
  });

  it("write only in src", () => {
    const cfg = {
      "write-only-in-src": {
        hook: "tool_call",
        filter: { toolName: "write" },
        shell:
          'echo "$PI_TOOL_INPUT" | grep -q \'"path":"src/\' && exit 0 || exit 1',
      },
    };
    assert.ok(validate(cfg), ajv.errorsText(validate.errors));
  });

  it("no sensitive reads", () => {
    const cfg = {
      "no-sensitive-reads": {
        hook: "tool_call",
        filter: { toolName: "read" },
        shell:
          'echo "$PI_TOOL_INPUT" | grep -qE \'\\.(env|pem|key)\' && exit 1 || exit 0',
      },
    };
    assert.ok(validate(cfg), ajv.errorsText(validate.errors));
  });

  it("default-based activation example", () => {
    const cfg = {
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
    };
    assert.ok(validate(cfg), ajv.errorsText(validate.errors));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Invalid configs
// ═══════════════════════════════════════════════════════════════════

describe("invalid configs rejected", () => {
  it("missing required 'hook'", () => {
    const cfg = { bad: { shell: "true" } };
    assert.strictEqual(validate(cfg), false);
  });

  it("missing required 'shell'", () => {
    const cfg = { bad: { hook: "tool_call" } };
    assert.strictEqual(validate(cfg), false);
  });

  it("unknown property at assert level", () => {
    const cfg = {
      bad: {
        hook: "tool_call",
        shell: "true",
        extraProp: "should not be here",
      },
    };
    assert.strictEqual(validate(cfg), false);
  });

  it("hook value not in enum", () => {
    const cfg = { bad: { hook: "invalid_hook", shell: "true" } };
    assert.strictEqual(validate(cfg), false);
  });

  it("default is not boolean", () => {
    const cfg = {
      bad: { hook: "tool_call", shell: "true", default: "yes" },
    };
    assert.strictEqual(validate(cfg), false);
  });

  it("top-level is not an object", () => {
    assert.strictEqual(validate([]), false);
    assert.strictEqual(validate("string"), false);
    assert.strictEqual(validate(null), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Schema evolution — future hook values
// ═══════════════════════════════════════════════════════════════════

describe("schema evolution readiness", () => {
  it("accepts only 'tool_call' for now", () => {
    const cfg = {
      guard: { hook: "tool_call", shell: "true" },
    };
    assert.ok(validate(cfg));

    // But 'tool_result' is not yet in the enum
    const future = {
      guard: { hook: "tool_result", shell: "true" },
    };
    assert.strictEqual(validate(future), false);
  });
});
