/**
 * Tests for matchFilter — filter matching against candidate records.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchFilter, type ToolCallEvent } from "../pi-assert/engine.js";

// ── Helper: build a candidate record from a ToolCallEvent ─────────
function candidateFrom(event: ToolCallEvent): Record<string, unknown> {
  return { toolName: event.toolName, ...event.input };
}

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
        assert.strictEqual(matchFilter(filter, candidateFrom(writeEvent)), true);
        assert.strictEqual(matchFilter(filter, candidateFrom(bashEvent)), true);
        assert.strictEqual(matchFilter(filter, candidateFrom(editEvent)), true);
        assert.strictEqual(matchFilter(filter, candidateFrom(emptyInput)), true);
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
        assert.strictEqual(matchFilter(filter, candidateFrom(event)), true);
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
        assert.strictEqual(matchFilter(filter, candidateFrom(event)), false);
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
        assert.strictEqual(matchFilter(filter, candidateFrom(event)), false);
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
        assert.strictEqual(matchFilter(filter, candidateFrom(event)), expected);
      });
    }
  });

  // ── Object & array values — reference vs any-of ────────────────

  describe("nested values — objects use ===, arrays are any-of", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    const evtWithEdits: ToolCallEvent = {
      toolName: "edit",
      toolCallId: "c",
      input: { edits },
    };

    // A plain (non-array) object filter value still uses === reference
    // equality, unchanged from v1.
    const obj = { foo: 1 };
    const evtWithObj: ToolCallEvent = {
      toolName: "edit",
      toolCallId: "c-obj",
      input: { meta: obj },
    };

    type Case = { label: string; filter: Record<string, unknown>; event: ToolCallEvent; expected: boolean };

    const cases: Case[] = [
      // Non-array object: === reference equality is still in effect.
      { label: "same object reference matches (===)",                       filter: { meta: obj },                               event: evtWithObj,    expected: true },
      { label: "different but deep-equal object does NOT match (===)",       filter: { meta: { foo: 1 } },                         event: evtWithObj,    expected: false },
      // Array filter values are now any-of, NOT reference equality.
      { label: "array ref no longer matches itself (any-of, not ===)",     filter: { edits },                                    event: evtWithEdits,  expected: false },
      { label: "array filter: candidate array is not an element",         filter: { edits: [{ oldText: "a", newText: "b" }] },   event: editEvent,     expected: false },
    ];

    for (const { label, filter, event, expected } of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, candidateFrom(event)), expected);
      });
    }
  });

  // ── Array filters — "any of" ───────────────────────────────────

  describe("array filter values — any of", () => {
    type Case = { label: string; filter: Record<string, unknown>; event: ToolCallEvent; expected: boolean };

    const cases: Case[] = [
      // toolName arrays
      { label: "toolName [write,edit] matches write",    filter: { toolName: ["write", "edit"] }, event: writeEvent,  expected: true },
      { label: "toolName [write,edit] matches edit",     filter: { toolName: ["write", "edit"] }, event: editEvent,   expected: true },
      { label: "toolName [write,edit] rejects bash",     filter: { toolName: ["write", "edit"] }, event: bashEvent,   expected: false },
      { label: "toolName [write,edit] rejects read",    filter: { toolName: ["write", "edit"] }, event: emptyInput,  expected: false },
      // single-element array ≡ scalar
      { label: "single-element array ≡ scalar (write)",  filter: { toolName: ["write"] },        event: writeEvent,  expected: true },
      { label: "single-element array ≡ scalar (reject)", filter: { toolName: ["write"] },        event: bashEvent,   expected: false },
      // array on a non-toolName key
      { label: "command [ls,pwd] matches ls",            filter: { command: ["ls", "pwd"] },      event: bashEvent,   expected: true },
      { label: "command [rm,pwd] rejects ls",           filter: { command: ["rm", "pwd"] },      event: bashEvent,   expected: false },
      // scalar + array keys combined (AND across keys, OR within a key)
      { label: "toolName [write,edit] + path matches",  filter: { toolName: ["write", "edit"], path: "/src/foo.ts" }, event: writeEvent, expected: true },
      { label: "toolName [write,edit] + wrong path",     filter: { toolName: ["write", "edit"], path: "/wrong" },      event: writeEvent, expected: false },
      // candidate key absent + array filter
      { label: "array on missing key → false",           filter: { missing: ["a", "b"] },         event: writeEvent,  expected: false },
      // empty array matches nothing
      { label: "empty toolName array rejects write",     filter: { toolName: [] },                 event: writeEvent,  expected: false },
      { label: "empty toolName array rejects read",      filter: { toolName: [] },                 event: emptyInput,  expected: false },
      { label: "empty toolName array rejects bash",     filter: { toolName: [] },                 event: bashEvent,   expected: false },
    ];

    for (const { label, filter, event, expected } of cases) {
      it(label, () => {
        assert.strictEqual(matchFilter(filter, candidateFrom(event)), expected);
      });
    }

    it("empty array on agent_end-style candidate → false", () => {
      assert.strictEqual(matchFilter({ event: [] }, { event: "agent_end" }), false);
    });

    it("array on a plain candidate (agent_end) matches", () => {
      assert.strictEqual(
        matchFilter({ event: ["agent_end", "other"] }, { event: "agent_end" }),
        true,
      );
    });
  });

  // ── Plain candidate (agent_end-style) ───────────────────────────

  describe("plain candidate (no ToolCallEvent)", () => {
    it("matches { event } candidate", () => {
      assert.strictEqual(
        matchFilter({ event: "agent_end" }, { event: "agent_end" }),
        true,
      );
      assert.strictEqual(
        matchFilter({ event: "agent_end" }, { event: "other" }),
        false,
      );
    });

    it("empty filter always matches plain candidate", () => {
      assert.strictEqual(matchFilter(undefined, { event: "agent_end" }), true);
      assert.strictEqual(matchFilter({}, { event: "agent_end" }), true);
    });

    it("key not in candidate → false", () => {
      assert.strictEqual(
        matchFilter({ toolName: "bash" }, { event: "agent_end" }),
        false,
      );
    });
  });
});
