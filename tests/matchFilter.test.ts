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
    type Case = { label: string; filter: Record<string, unknown> | undefined };

    const cases: Case[] = [
      { label: "undefined",        filter: undefined },
      { label: "empty object {}",  filter: {} },
    ];

    for (const { label, filter } of cases) {
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
    type Case = { label: string; filter: Record<string, unknown>; event: ToolCallEvent };

    const cases: Case[] = [
      { label: "toolName only",                 filter: { toolName: "write" },                            event: writeEvent },
      { label: "input field (path)",            filter: { path: "/src/foo.ts" },                           event: writeEvent },
      { label: "input field (command)",         filter: { command: "ls" },                                event: bashEvent },
      { label: "toolName + path",               filter: { toolName: "write", path: "/src/foo.ts" },       event: writeEvent },
      { label: "toolName + command",            filter: { toolName: "bash", command: "ls" },              event: bashEvent },
      { label: "toolName + timeout",            filter: { toolName: "bash", timeout: 10 },                event: bashEvent },
      { label: "command + timeout",             filter: { command: "ls", timeout: 10 },                   event: bashEvent },
      { label: "toolName + command + timeout",  filter: { toolName: "bash", command: "ls", timeout: 10 }, event: bashEvent },
    ];

    for (const { label, filter, event } of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), true);
      });
    }
  });

  // ── Negative matches ────────────────────────────────────────────

  describe("negative matches (key present but value differs)", () => {
    type Case = { label: string; filter: Record<string, unknown>; event: ToolCallEvent };

    const cases: Case[] = [
      { label: "toolName mismatch (write vs bash)",       filter: { toolName: "bash" },                   event: writeEvent },
      { label: "toolName mismatch (write vs edit)",       filter: { toolName: "edit" },                   event: writeEvent },
      { label: "path mismatch",                           filter: { path: "/src/bar.ts" },                event: writeEvent },
      { label: "command mismatch",                        filter: { command: "rm" },                      event: bashEvent },
      { label: "timeout mismatch",                        filter: { timeout: 5 },                         event: bashEvent },
      { label: "one matches, one mismatches",             filter: { toolName: "write", path: "/wrong" },  event: writeEvent },
      { label: "one matches, one mismatches (bash)",      filter: { toolName: "bash", command: "rm" },    event: bashEvent },
    ];

    for (const { label, filter, event } of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), false);
      });
    }
  });

  // ── Key not in candidate → false ────────────────────────────────

  describe("key not in candidate → false", () => {
    type Case = { label: string; filter: Record<string, unknown>; event: ToolCallEvent };

    const cases: Case[] = [
      { label: "extra key 'other'",                     filter: { other: 42 },                        event: writeEvent },
      { label: "extra key in empty input",              filter: { path: "/x" },                       event: emptyInput },
      { label: "toolName matches but extra key fails",  filter: { toolName: "write", extra: 1 },      event: writeEvent },
    ];

    for (const { label, filter, event } of cases) {
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

    type Case = { label: string; filter: Record<string, unknown>; event: ToolCallEvent; expected: boolean };

    const cases: Case[] = [
      { label: 'string "10" ≠ number 10',                filter: { timeout: "10" },             event: bashEvent,          expected: false },
      { label: "number 0 = number 0",                    filter: { count: 0 },                  event: numEvent,           expected: true },
      { label: "boolean false = boolean false",          filter: { flag: false },               event: numEvent,           expected: true },
      { label: "null = null",                            filter: { name: null },                event: numEvent,           expected: true },
      { label: "number mismatched against boolean",      filter: { count: false as any },        event: numEvent,           expected: false },
      { label: "undefined present in candidate → matches",   filter: { present: undefined as any }, event: evtWithUndefined, expected: true },
      { label: "undefined absent from candidate → also matches", filter: { absent: undefined as any }, event: evtWithUndefined, expected: true },
    ];

    for (const { label, filter, event, expected } of cases) {
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

    type Case = { label: string; filter: Record<string, unknown>; event: ToolCallEvent; expected: boolean };

    const cases: Case[] = [
      { label: "same object reference matches",                         filter: { edits },                                      event: evtWithEdits,  expected: true },
      { label: "different but deep-equal does NOT match (===)",         filter: { edits: [{ oldText: "a", newText: "b" }] },    event: editEvent,     expected: false },
    ];

    for (const { label, filter, event, expected } of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, event), expected);
      });
    }
  });
});
