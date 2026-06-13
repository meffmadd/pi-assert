/**
 * Tests for buildResultEnv — environment variable construction for tool_result hooks.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildResultEnv,
  type ToolResultEvent,
  type ExtensionContext,
} from "../pi-assert/engine.js";

// ── Shared values ──────────────────────────────────────────────────

const ctx: ExtensionContext = { cwd: "/home/user/project" };

// ═══════════════════════════════════════════════════════════════════
// buildResultEnv
// ═══════════════════════════════════════════════════════════════════

describe("buildResultEnv", () => {
  // ── Basic env construction ─────────────────────────────────────

  it("builds correct env for a single text content block", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      toolCallId: "call-1",
      input: { path: "/f.ts" },
      content: [{ type: "text", text: "file contents" }],
      isError: false,
    };

    const env = buildResultEnv(event, ctx);

    assert.strictEqual(env.PI_TOOL_NAME, "read");
    assert.strictEqual(env.PI_TOOL_CALL_ID, "call-1");
    assert.strictEqual(env.PI_TOOL_INPUT, '{"path":"/f.ts"}');
    assert.strictEqual(env.PI_TOOL_RESULT, "file contents");
    assert.strictEqual(env.PI_TOOL_IS_ERROR, "false");
    assert.strictEqual(env.PI_CWD, "/home/user/project");
  });

  // ── Multiple text content blocks joined by newline ─────────────

  it("joins multiple text content blocks with \\n", () => {
    const event: ToolResultEvent = {
      toolName: "bash",
      toolCallId: "call-2",
      input: { command: "ls" },
      content: [
        { type: "text", text: "file1.ts" },
        { type: "text", text: "file2.ts" },
        { type: "text", text: "file3.ts" },
      ],
      isError: false,
    };

    const env = buildResultEnv(event, ctx);
    assert.strictEqual(env.PI_TOOL_RESULT, "file1.ts\nfile2.ts\nfile3.ts");
  });

  // ── Image content blocks are skipped ───────────────────────────

  it("skips image content blocks in PI_TOOL_RESULT", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      toolCallId: "call-3",
      input: { path: "/img.png" },
      content: [
        { type: "text", text: "before" },
        { type: "image", data: "base64data", mimeType: "image/png" },
        { type: "text", text: "after" },
      ],
      isError: false,
    };

    const env = buildResultEnv(event, ctx);
    assert.strictEqual(env.PI_TOOL_RESULT, "before\nafter");
  });

  // ── isError flips PI_TOOL_IS_ERROR ──────────────────────────────

  it("PI_TOOL_IS_ERROR is 'true' when isError is true", () => {
    const event: ToolResultEvent = {
      toolName: "bash",
      toolCallId: "call-4",
      input: { command: "false" },
      content: [{ type: "text", text: "command failed" }],
      isError: true,
    };

    const env = buildResultEnv(event, ctx);
    assert.strictEqual(env.PI_TOOL_IS_ERROR, "true");
  });

  // ── Empty content array ────────────────────────────────────────

  it("empty content array → empty PI_TOOL_RESULT", () => {
    const event: ToolResultEvent = {
      toolName: "bash",
      toolCallId: "call-5",
      input: { command: "true" },
      content: [],
      isError: false,
    };

    const env = buildResultEnv(event, ctx);
    assert.strictEqual(env.PI_TOOL_RESULT, "");
  });

  // ── cwd flows from context ─────────────────────────────────────

  it("cwd flows from context correctly", () => {
    type Case = { cwd: string; expected: string };

    const cases: Case[] = [
      { cwd: "/home/user/project",       expected: "/home/user/project" },
      { cwd: "/tmp",                     expected: "/tmp" },
      { cwd: "/very/deep/nested/path",   expected: "/very/deep/nested/path" },
      { cwd: "relative/path",            expected: "relative/path" },
      { cwd: "",                         expected: "" },
    ];

    for (const { cwd: cwdValue, expected } of cases) {
      const c: ExtensionContext = { cwd: cwdValue };
      const event: ToolResultEvent = {
        toolName: "read",
        toolCallId: "c",
        input: {},
        content: [],
        isError: false,
      };

      const env = buildResultEnv(event, c);
      assert.strictEqual(env.PI_CWD, expected);
    }
  });

  // ── Input is JSON-stringified ──────────────────────────────────

  it("PI_TOOL_INPUT is JSON-stringified input", () => {
    const event: ToolResultEvent = {
      toolName: "bash",
      toolCallId: "c",
      input: { command: "echo hi", timeout: 30 },
      content: [],
      isError: false,
    };

    const env = buildResultEnv(event, ctx);
    assert.strictEqual(env.PI_TOOL_INPUT, '{"command":"echo hi","timeout":30}');
  });

  // ── Realistic .env leak scenario ──────────────────────────────

  it("supports .env-style multi-line content for grep", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      toolCallId: "c",
      input: { path: "/app/.env" },
      content: [
        {
          type: "text",
          text: "DATABASE_URL=postgres://localhost/db\nAPI_KEY=sk-12345\nDEBUG=true",
        },
      ],
      isError: false,
    };

    const env = buildResultEnv(event, ctx);
    assert.strictEqual(
      env.PI_TOOL_RESULT,
      "DATABASE_URL=postgres://localhost/db\nAPI_KEY=sk-12345\nDEBUG=true",
    );
  });
});
