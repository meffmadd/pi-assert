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
  // ── Various tool types ─────────────────────────────────────────

  describe("various tool types", () => {
    type Case = {
      label: string;
      toolName: string;
      input: Record<string, unknown>;
      expectedInput: string;
    };

    const cases: Case[] = [
      { label: "write",              toolName: "write", input: { path: "/f.ts", content: "hello" }, expectedInput: '{"path":"/f.ts","content":"hello"}' },
      { label: "read",               toolName: "read",  input: { path: "/f.ts" },                     expectedInput: '{"path":"/f.ts"}' },
      { label: "edit",               toolName: "edit",  input: { path: "/f.ts", edits: [{ oldText: "a", newText: "b" }] }, expectedInput: '{"path":"/f.ts","edits":[{"oldText":"a","newText":"b"}]}' },
      { label: "bash w/ timeout",    toolName: "bash",  input: { command: "ls", timeout: 30 },       expectedInput: '{"command":"ls","timeout":30}' },
      { label: "bash w/o timeout",   toolName: "bash",  input: { command: "git status" },            expectedInput: '{"command":"git status"}' },
    ];

    for (const { label, toolName, input, expectedInput } of cases) {
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

  // ── Edge-case input ─────────────────────────────────────────────

  describe("edge-case input", () => {
    type Case = {
      label: string;
      input: Record<string, unknown>;
      expectedInput: string;
    };

    const cases: Case[] = [
      { label: "empty input",                  input: {},                                        expectedInput: "{}" },
      { label: "empty string value",           input: { path: "" },                             expectedInput: '{"path":""}' },
      { label: "null value",                   input: { path: null as any },                    expectedInput: '{"path":null}' },
      { label: "boolean value",                input: { force: true },                          expectedInput: '{"force":true}' },
      { label: "number value",                 input: { count: 0 },                             expectedInput: '{"count":0}' },
      { label: "array value",                  input: { items: [1, 2, 3] },                     expectedInput: '{"items":[1,2,3]}' },
      { label: "newline escapes (no literal \n in JSON)", input: { command: "echo 'hello\nworld'" }, expectedInput: '{"command":"echo \'hello\\nworld\'"}' },
      { label: "special characters → escaped", input: { command: 'echo "double" and \'single\' and \\ backslash' }, expectedInput: '{"command":"echo \\"double\\" and \'single\' and \\\\ backslash"}' },
    ];

    for (const { label, input, expectedInput } of cases) {
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

  // ── Different CWD values ────────────────────────────────────────

  it("cwd flows from context correctly", () => {
    type Case = { cwd: string; expected: string };

    const cases: Case[] = [
      { cwd: "/home/user/project",       expected: "/home/user/project" },
      { cwd: "/tmp",                     expected: "/tmp" },
      { cwd: "/very/deep/nested/path",   expected: "/very/deep/nested/path" },
      { cwd: "relative/path",            expected: "relative/path" },
    ];

    for (const { cwd: cwdValue, expected } of cases) {
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

});
