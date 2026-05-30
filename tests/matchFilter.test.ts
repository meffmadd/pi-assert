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

// ═══════════════════════════════════════════════════════════════════
// matchFilter
// ═══════════════════════════════════════════════════════════════════

describe("matchFilter", () => {
  // 2.1 ── No filter (always matches) ──────────────────────────────

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

  // 2.2 ── Positive matches ────────────────────────────────────────

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

  // 2.3 ── Negative matches ────────────────────────────────────────

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

  // 2.4 ── Key not in candidate ────────────────────────────────────

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

  // 2.5 ── Type coercion (v1 uses strict ===) ──────────────────────

  describe("type coercion — v1 uses strict ===", () => {
    const numEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "call-num",
      input: { count: 0, threshold: 0.5, flag: false, name: null as any },
    };

    const cases: [string, Record<string, unknown>, boolean][] = [
      ['string "10" ≠ number 10', { timeout: "10" }, false],
      ["number 0 = number 0", { count: 0 }, true],
      ["boolean false = boolean false", { flag: false }, true],
      ["null = null", { name: null }, true],
      ["number mismatched against boolean", { count: false as any }, false],
    ];

    for (const [label, filter, expected] of cases) {
      it(label, () => {
        const event = label.startsWith("string") ? bashEvent : numEvent;
        assert.strictEqual(matchFilter(filter, event), expected);
      });
    }

    // undefined check: candidate[key] on absent key returns undefined,
    // which is never === to any value (including undefined itself via filter JSON)
    it("undefined ≠ undefined (key absent from candidate)", () => {
      // Even if the filter has `{ missing: undefined }` it won't match
      // because candidate["missing"] returns undefined, and
      // undefined !== undefined ... wait, actually undefined === undefined.
      // But in JSON there's no undefined. Let's just note:
      // a filter can't express undefined since JSON has no undefined.
      // If someone passes undefined programmatically, it would be ===
      // only if the candidate also has that key set to undefined.
      const evt: ToolCallEvent = {
        toolName: "test",
        toolCallId: "c",
        input: { present: undefined as any },
      };
      // candidate.present === undefined → true
      assert.strictEqual(matchFilter({ present: undefined as any }, evt), true);
      // candidate.absent === undefined → also true!
      assert.strictEqual(matchFilter({ absent: undefined as any }, evt), true);
    });
  });

  // 2.6 ── Filter with nested objects (v1: exact reference match) ──

  describe("nested objects — exact reference match", () => {
    it("same object reference matches", () => {
      const edits = [{ oldText: "a", newText: "b" }];
      const evt: ToolCallEvent = {
        toolName: "edit",
        toolCallId: "c",
        input: { edits },
      };
      assert.strictEqual(matchFilter({ edits }, evt), true);
    });

    it("different but deep-equal object does NOT match (===)", () => {
      const evt: ToolCallEvent = {
        toolName: "edit",
        toolCallId: "c",
        input: { edits: [{ oldText: "a", newText: "b" }] },
      };
      assert.strictEqual(
        matchFilter({ edits: [{ oldText: "a", newText: "b" }] }, evt),
        false,
      );
    });
  });
});
