/**
 * Tests for buildEnv — environment variable construction.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildEnv, type ToolCallEvent, type ExtensionContext } from "../pi-assert/engine.js";

// ── Shared values ──────────────────────────────────────────────────

const ctx: ExtensionContext = { cwd: "/home/user/project" };

// ═══════════════════════════════════════════════════════════════════
// buildEnv
// ═══════════════════════════════════════════════════════════════════

describe("buildEnv", () => {
  // 3.1 ── All four variables present ──────────────────────────────

  it("all four variables present with correct values", () => {
    const event: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "call-abc-123",
      input: { command: "ls -la", timeout: 10 },
    };

    const env = buildEnv(event, ctx);

    assert.strictEqual(env.PI_TOOL_NAME, "bash");
    assert.strictEqual(env.PI_TOOL_CALL_ID, "call-abc-123");
    assert.strictEqual(env.PI_TOOL_INPUT, '{"command":"ls -la","timeout":10}');
    assert.strictEqual(env.PI_CWD, "/home/user/project");
  });

  // 3.2 ── Various tool types ──────────────────────────────────────

  describe("various tool types", () => {
    const cases: [string, string, Record<string, unknown>, string][] = [
      [
        "write",
        "write",
        { path: "/f.ts", content: "hello" },
        '{"path":"/f.ts","content":"hello"}',
      ],
      [
        "read",
        "read",
        { path: "/f.ts" },
        '{"path":"/f.ts"}',
      ],
      [
        "edit",
        "edit",
        { path: "/f.ts", edits: [{ oldText: "a", newText: "b" }] },
        '{"path":"/f.ts","edits":[{"oldText":"a","newText":"b"}]}',
      ],
      [
        "bash w/ timeout",
        "bash",
        { command: "ls", timeout: 30 },
        '{"command":"ls","timeout":30}',
      ],
      [
        "bash w/o timeout",
        "bash",
        { command: "git status" },
        '{"command":"git status"}',
      ],
    ];

    for (const [label, toolName, input, expectedInput] of cases) {
      it(label, () => {
        const event: ToolCallEvent = {
          toolName,
          toolCallId: "call-1",
          input,
        };

        const env = buildEnv(event, ctx);

        assert.strictEqual(env.PI_TOOL_NAME, toolName);
        assert.strictEqual(env.PI_TOOL_CALL_ID, "call-1");
        assert.strictEqual(env.PI_TOOL_INPUT, expectedInput);
        assert.strictEqual(env.PI_CWD, "/home/user/project");
      });
    }
  });

  // 3.3 ── Edge-case input ─────────────────────────────────────────

  describe("edge-case input", () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["empty input", {}, "{}"],
      ["empty string value", { path: "" }, '{"path":""}'],
      ["null value", { path: null as any }, '{"path":null}'],
      ["boolean value", { force: true }, '{"force":true}'],
      ["number value", { count: 0 }, '{"count":0}'],
      ["array value", { items: [1, 2, 3] }, '{"items":[1,2,3]}'],
    ];

    for (const [label, input, expectedInput] of cases) {
      it(label, () => {
        const event: ToolCallEvent = {
          toolName: "test",
          toolCallId: "call-e",
          input,
        };

        const env = buildEnv(event, ctx);
        assert.strictEqual(env.PI_TOOL_INPUT, expectedInput);
      });
    }
  });

  // 3.4 ── Different CWD values ────────────────────────────────────

  it("cwd flows from context correctly", () => {
    const cases: [string, string][] = [
      ["/home/user/project", "/home/user/project"],
      ["/tmp", "/tmp"],
      ["/very/deep/nested/path", "/very/deep/nested/path"],
      ["relative/path", "relative/path"],
    ];

    for (const [cwdValue, expected] of cases) {
      const c: ExtensionContext = { cwd: cwdValue };
      const event: ToolCallEvent = {
        toolName: "test",
        toolCallId: "c",
        input: {},
      };

      const env = buildEnv(event, c);
      assert.strictEqual(env.PI_CWD, expected);
    }
  });

  // 3.5 ── PI_TOOL_INPUT is a single-line JSON string ──────────────

  it("PI_TOOL_INPUT is always single-line (no pretty-print)", () => {
    const event: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c",
      input: { command: "echo 'hello\nworld'" },
    };

    const env = buildEnv(event, ctx);
    // Should NOT contain newlines
    assert.strictEqual(env.PI_TOOL_INPUT.includes("\n"), false);
  });

  // 3.6 ── Special characters in input values ──────────────────────

  it("special characters are escaped in JSON", () => {
    const event: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c",
      input: { command: 'echo "double" and \'single\' and \\ backslash' },
    };

    const env = buildEnv(event, ctx);
    // JSON.stringify handles escaping
    assert.ok(env.PI_TOOL_INPUT.includes('\\"'));
    assert.ok(env.PI_TOOL_INPUT.includes("\\\\"));
  });
});
