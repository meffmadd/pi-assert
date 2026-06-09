/**
 * Tests for matchFilter — filter matching against tool_call events.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchFilter, type ToolCallEvent } from "../pi-assert/engine.js";

// ── Shared events ──────────────────────────────────────────────────

const writeEvent: ToolCallEvent = {
  toolName: "write",
  toolCallId: "call-1",
  input: { path: "/src/foo.ts", content: "hello" },
};

const bashEvent: ToolCallEvent = {
  toolName: "bash",
  toolCallId: "call-2",
  input: { command: "ls", timeout: 10 },
};

const editEvent: ToolCallEvent = {
  toolName: "edit",
  toolCallId: "call-3",
  input: {
    path: "/src/foo.ts",
    edits: [{ oldText: "a", newText: "b" }],
  },
};

const emptyInput: ToolCallEvent = {
  toolName: "read",
  toolCallId: "call-4",
  input: {},
};

const numEvent: ToolCallEvent = {
  toolName: "bash",
  toolCallId: "call-num",
  input: { count: 0, threshold: 0.5, flag: false, name: null as any },
};

// ═══════════════════════════════════════════════════════════════════
// matchFilter
// ═══════════════════════════════════════════════════════════════════

describe("matchFilter", () => {
  // ── No filter (always matches) ──────────────────────────────────

  describe("no filter → always true", () => {
    const cases: [string, Record<string, unknown> | undefined][] = [
      ["undefined", undefined],
      ["empty object {}", {}],
    ];

    for (const [label, filter] of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, writeEvent), true);
        assert.strictEqual(matchFilter(filter, bashEvent), true);
        assert.strictEqual(matchFilter(filter, editEvent), true);
        assert.strictEqual(matchFilter(filter, emptyInput), true);
      });
    }
  });

  // ── Positive matches ────────────────────────────────────────────

  describe("positive matches (all filter keys present & equal)", () => {
    const cases: [string, Record<string, unknown>, ToolCallEvent][] = [
      ["toolName only", { toolName: "write" }, writeEvent],
      ["input field (path)", { path: "/src/foo.ts" }, writeEvent],
      ["input field (command)", { command: "ls" }, bashEvent],
      ["toolName + path", { toolName: "write", path: "/src/foo.ts" }, writeEvent],
      ["toolName + command", { toolName: "bash", command: "ls" }, bashEvent],
      ["toolName + timeout", { toolName: "bash", timeout: 10 }, bashEvent],
      ["command + timeout", { command: "ls", timeout: 10 }, bashEvent],
      ["toolName + command + timeout", { toolName: "bash", command: "ls", timeout: 10 }, bashEvent],
    ];

    for (const [label, filter, event] of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), true);
      });
    }
  });

  // ── Negative matches ────────────────────────────────────────────

  describe("negative matches (key present but value differs)", () => {
    const cases: [string, Record<string, unknown>, ToolCallEvent][] = [
      ["toolName mismatch (write vs bash)", { toolName: "bash" }, writeEvent],
      ["toolName mismatch (write vs edit)", { toolName: "edit" }, writeEvent],
      ["path mismatch", { path: "/src/bar.ts" }, writeEvent],
      ["command mismatch", { command: "rm" }, bashEvent],
      ["timeout mismatch", { timeout: 5 }, bashEvent],
      ["one matches, one mismatches", { toolName: "write", path: "/wrong" }, writeEvent],
      ["one matches, one mismatches (bash)", { toolName: "bash", command: "rm" }, bashEvent],
    ];

    for (const [label, filter, event] of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), false);
      });
    }
  });

  // ── Key not in candidate → false ────────────────────────────────

  describe("key not in candidate → false", () => {
    const cases: [string, Record<string, unknown>, ToolCallEvent][] = [
      ["extra key 'other'", { other: 42 }, writeEvent],
      ["extra key in empty input", { path: "/x" }, emptyInput],
      ["toolName matches but extra key fails", { toolName: "write", extra: 1 }, writeEvent],
    ];

    for (const [label, filter, event] of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), false);
      });
    }
  });

  // ── Type coercion (v1 uses strict ===) ──────────────────────────

  describe("type coercion — v1 uses strict ===", () => {
    const evtWithUndefined: ToolCallEvent = {
      toolName: "test",
      toolCallId: "c",
      input: { present: undefined as any },
    };

    const cases: [string, Record<string, unknown>, ToolCallEvent, boolean][] = [
      ['string "10" ≠ number 10', { timeout: "10" }, bashEvent, false],
      ["number 0 = number 0", { count: 0 }, numEvent, true],
      ["boolean false = boolean false", { flag: false }, numEvent, true],
      ["null = null", { name: null }, numEvent, true],
      ["number mismatched against boolean", { count: false as any }, numEvent, false],
      ["undefined present in candidate → matches", { present: undefined as any }, evtWithUndefined, true],
      ["undefined absent from candidate → also matches", { absent: undefined as any }, evtWithUndefined, true],
    ];

    for (const [label, filter, event, expected] of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), expected);
      });
    }
  });

  // ── Nested objects — exact reference match ──────────────────────

  describe("nested objects — exact reference match", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    const evtWithEdits: ToolCallEvent = {
      toolName: "edit",
      toolCallId: "c",
      input: { edits },
    };

    const cases: [string, Record<string, unknown>, ToolCallEvent, boolean][] = [
      ["same object reference matches", { edits }, evtWithEdits, true],
      ["different but deep-equal does NOT match (===)", { edits: [{ oldText: "a", newText: "b" }] }, editEvent, false],
    ];

    for (const [label, filter, event, expected] of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), expected);
      });
    }
  });
});
