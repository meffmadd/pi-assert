/**
 * Tests for the pure outdated-detection functions in installer.ts:
 * `entryContentSignature`, `entryNeedsUpdate`, `classifyEntry`, and the
 * shared `cleanEntry` record builder.
 *
 * These are pure (no I/O), so the tests are plain value comparisons.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cleanEntry,
  classifyEntry,
  entryContentSignature,
  entryNeedsUpdate,
  type EntryState,
  type RuleEntry,
  type SignableEntry,
} from "../pi-assert/installer.js";

// ── Fixtures ─────────────────────────────────────────────────────

const base: SignableEntry = {
  description: "Blocks writes.",
  hook: "tool_call",
  shell: "false",
};

/** Clone `base` and override selected fields. */
function with_(
  overrides: Partial<SignableEntry>,
  baseEntry: SignableEntry = base,
): SignableEntry {
  return { ...baseEntry, ...overrides };
}

const ruleEntry: RuleEntry = {
  description: "Blocks writes.",
  hook: "tool_call",
  shell: "false",
};

// ═══════════════════════════════════════════════════════════════════
// entryContentSignature
// ═══════════════════════════════════════════════════════════════════

describe("entryContentSignature", () => {
  it("includes description, hook, shell and omits absent filter/when", () => {
    assert.deepStrictEqual(
      entryContentSignature({ description: "d", hook: "h", shell: "s" }),
      { description: "d", hook: "h", shell: "s" },
    );
  });

  it("includes filter and when only when present", () => {
    assert.deepStrictEqual(
      entryContentSignature({
        description: "d",
        hook: "h",
        shell: "s",
        filter: { toolName: "write" },
        when: "true",
      }),
      {
        description: "d",
        hook: "h",
        shell: "s",
        filter: { toolName: "write" },
        when: "true",
      },
    );
  });

  it("excludes default (a local-only preference)", () => {
    const sig = entryContentSignature({
      description: "d",
      hook: "h",
      shell: "s",
      default: true,
    } as RuleEntry);
    assert.ok(!("default" in sig), "default must not appear in the signature");
  });

  it("never emits undefined-valued keys", () => {
    const sig = entryContentSignature({
      description: "d",
      hook: "h",
      shell: "s",
      filter: undefined,
      when: undefined,
    });
    assert.deepStrictEqual(sig, { description: "d", hook: "h", shell: "s" });
    assert.ok(!("filter" in sig));
    assert.ok(!("when" in sig));
  });
});

// ═══════════════════════════════════════════════════════════════════
// entryNeedsUpdate
// ═══════════════════════════════════════════════════════════════════

describe("entryNeedsUpdate", () => {
  it("returns false for identical entries", () => {
    assert.strictEqual(entryNeedsUpdate(base, with_({})), false);
  });

  it("returns false when only default differs (default is excluded)", () => {
    const installed = { ...base, default: true } as RuleEntry;
    const repo = { ...base } as RuleEntry;
    assert.strictEqual(entryNeedsUpdate(installed, repo), false);
  });

  it("returns false when default differs in both directions", () => {
    const installed = { ...base } as RuleEntry;
    const repo = { ...base, default: true } as RuleEntry;
    assert.strictEqual(entryNeedsUpdate(installed, repo), false);
  });

  it("returns true when description differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ description: "Different." })),
      true,
    );
  });

  it("returns true when hook differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ hook: "tool_result" })),
      true,
    );
  });

  it("returns true when shell differs", () => {
    assert.strictEqual(entryNeedsUpdate(base, with_({ shell: "true" })), true);
  });

  it("returns true when filter differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ filter: { toolName: "bash" } })),
      true,
    );
  });

  it("returns true when when differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ when: "git diff --quiet" })),
      true,
    );
  });

  it("returns false when filter is absent on both sides", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", hook: "h", shell: "s" },
        { description: "d", hook: "h", shell: "s" },
      ),
      false,
    );
  });

  it("returns true when filter is present on one side but not the other", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", hook: "h", shell: "s" },
        { description: "d", hook: "h", shell: "s", filter: { toolName: "x" } },
      ),
      true,
    );
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", hook: "h", shell: "s", filter: { toolName: "x" } },
        { description: "d", hook: "h", shell: "s" },
      ),
      true,
    );
  });

  it("returns false when filter keys are in a different order (order-independent)", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        {
          description: "d",
          hook: "h",
          shell: "s",
          filter: { a: "1", b: "2" },
        },
        {
          description: "d",
          hook: "h",
          shell: "s",
          filter: { b: "2", a: "1" },
        },
      ),
      false,
    );
  });

  it("returns false when when is absent on both sides", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", hook: "h", shell: "s" },
        { description: "d", hook: "h", shell: "s" },
      ),
      false,
    );
  });

  it("returns true when when is present on one side but not the other", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", hook: "h", shell: "s" },
        { description: "d", hook: "h", shell: "s", when: "true" },
      ),
      true,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// classifyEntry
// ═══════════════════════════════════════════════════════════════════

describe("classifyEntry", () => {
  it("returns 'not-installed' when installed is undefined", () => {
    assert.strictEqual(
      classifyEntry(base, undefined),
      "not-installed" as EntryState,
    );
  });

  it("returns 'installed' when content matches", () => {
    assert.strictEqual(
      classifyEntry(base, with_({})),
      "installed" as EntryState,
    );
  });

  it("returns 'installed' when only default differs", () => {
    assert.strictEqual(
      classifyEntry(base, { ...base, default: true } as RuleEntry),
      "installed" as EntryState,
    );
  });

  it("returns 'outdated' when shell differs", () => {
    assert.strictEqual(
      classifyEntry(base, with_({ shell: "true" })),
      "outdated" as EntryState,
    );
  });

  it("returns 'outdated' when filter differs", () => {
    assert.strictEqual(
      classifyEntry(base, with_({ filter: { toolName: "bash" } })),
      "outdated" as EntryState,
    );
  });

  it("returns 'outdated' when description differs", () => {
    assert.strictEqual(
      classifyEntry(base, with_({ description: "New description." })),
      "outdated" as EntryState,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// cleanEntry (shared by installRule + updateRule)
// ═══════════════════════════════════════════════════════════════════

describe("cleanEntry", () => {
  it("emits description, hook, shell in a stable key order", () => {
    const clean = cleanEntry(ruleEntry);
    assert.deepStrictEqual(
      Object.keys(clean),
      ["description", "hook", "shell"],
    );
  });

  it("omits optional fields when absent", () => {
    assert.deepStrictEqual(cleanEntry(ruleEntry), {
      description: "Blocks writes.",
      hook: "tool_call",
      shell: "false",
    });
  });

  it("includes filter, when, default in that order when present", () => {
    const clean = cleanEntry({
      description: "d",
      hook: "h",
      shell: "s",
      filter: { toolName: "bash" },
      when: "true",
      default: true,
    });
    assert.deepStrictEqual(Object.keys(clean), [
      "description",
      "hook",
      "shell",
      "filter",
      "when",
      "default",
    ]);
    assert.deepStrictEqual(clean, {
      description: "d",
      hook: "h",
      shell: "s",
      filter: { toolName: "bash" },
      when: "true",
      default: true,
    });
  });
});
