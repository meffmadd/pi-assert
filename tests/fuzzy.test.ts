/**
 * Tests for the pure fuzzy matcher (`pi-assert/ui/fuzzy.ts`).
 *
 * These assert derivable *orderings* and match/non-match, not raw score
 * numbers — the scoring constants are an implementation detail. Tier
 * dominance and within-section stability are the contract.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fuzzyMatch,
  matchQuery,
  filterSection,
} from "../pi-assert/ui/fuzzy.js";
import type { Assert } from "../pi-assert/engine.js";

function makeAssert(
  name: string,
  opts: {
    source?: string;
    description?: string;
    shell?: string;
    when?: string;
  } = {},
): Assert {
  return {
    name,
    source: opts.source ?? "local",
    description: opts.description ?? "",
    hook: "tool_call",
    shell: opts.shell ?? "true",
    when: opts.when,
    default: false,
    path: `/tmp/${name}.json`,
  };
}

// ── fuzzyMatch ─────────────────────────────────────────────────────

describe("fuzzyMatch", () => {
  it("matches a subsequence", () => {
    const m = fuzzyMatch("wrg", "write-guard");
    assert.ok(m, "wrg is a subsequence of write-guard");
    assert.deepEqual(m!.positions, [0, 1, 6]); // w,r,g in 'write-guard'
  });

  it("returns null when not a subsequence", () => {
    assert.equal(fuzzyMatch("xyz", "write-guard"), null);
  });

  it("is case-insensitive", () => {
    assert.ok(fuzzyMatch("ENV", "no-env"), "ENV matches no-env");
  });

  it("returns score 0 for an empty query", () => {
    const m = fuzzyMatch("", "anything");
    assert.ok(m);
    assert.equal(m!.score, 0);
    assert.deepEqual(m!.positions, []);
  });

  it("rewards contiguous matches over scattered ones", () => {
    const contiguous = fuzzyMatch("wr", "write")!;          // positions 0,1
    const scattered = fuzzyMatch("wr", "war-ready")!;        // positions 0,2
    assert.ok(contiguous.score > scattered.score,
      "contiguous 'wr' in 'write' outscores scattered 'wr' in 'war-ready'");
  });

  it("rewards word-boundary matches over mid-word ones", () => {
    const boundary = fuzzyMatch("env", "no-env")!;   // 'env' preceded by '-'
    const midword = fuzzyMatch("env", "gonnaenv")!;   // same target length-1-ish, mid-word
    assert.ok(boundary.score > midword.score,
      "boundary 'env' in 'no-env' outscores mid-word 'env' in 'gonnaenv'");
  });

  it("rewards camelCase boundaries", () => {
    const camel = fuzzyMatch("g", "fooGuard")!;        // boundary at camelCase G
    const plain = fuzzyMatch("g", "fooguard")!;         // mid-word g (lowercase)
    // The camelCase 'G' is a boundary; the lowercase 'g' in 'fooguard' is not
    // (mid-word, no boundary char). Both share earliness but camel scores
    // the boundary bonus.
    assert.ok(camel.score > plain.score,
      "camelCase boundary outscores mid-word lowercase");
  });

  // ── fzf-style gap penalty + 0-clamp + first-char multiplier (#1/#2/#3) ─────

  it("gap penalty: a tight match outscores a scattered one of the same length", () => {
    // 'ab' contiguous at the start of 'able' (boundary + consec chars)
    // beats 'ab' scattered across 'a................b' (one big gap).
    const tight = fuzzyMatch("ab", "able")!;
    const scattered = fuzzyMatch("ab", "a" + "x".repeat(20) + "b")!;
    assert.ok(tight.score > scattered.score,
      "contiguous 'ab' outscores scattered 'ab' across a long gap");
  });

  it("gap penalty grows with the gap, so wider gaps score lower", () => {
    const narrow = fuzzyMatch("ab", "a" + "x".repeat(4) + "b")!;
    const wider = fuzzyMatch("ab", "a" + "x".repeat(40) + "b")!;
    assert.ok(narrow.score > wider.score,
      "a 4-char gap outscores a 40-char gap");
  });

  it("0-clamp: a hugely-scattered hit scores 0 (dead path)", () => {
    // Gaps so wide that the gap penalty eats all the accumulated bonus.
    const dead = fuzzyMatch("git", "g" + "x".repeat(120) + "i" + "x".repeat(120) + "t")!;
    assert.equal(dead.score, 0,
      "a path whose gap penalties cancel all bonus is clamped to 0");
  });

  it("first-char multiplier: a boundary-first match beats a mid-word one", () => {
    // Both targets have 'g' as a subsequence; 'foo/g' has it at a word
    // boundary (after '/') for the FIRST pattern char, which is doubled.
    // 'fooag' has 'g' mid-word (no boundary) — bonus is 0 either way.
    const boundaryFirst = fuzzyMatch("g", "foo/g")!;   // 'g' after '/'
    const midword = fuzzyMatch("g", "fooag")!;          // 'g' mid-word
    assert.ok(boundaryFirst.score > midword.score,
      "a boundary first-char match (bonus doubled) outranks a mid-word one");
  });
});

// ── matchQuery (query normalization seam) ───────────────────────────

describe("matchQuery", () => {
  it("ignores spaces in the query (v1a strip)", () => {
    assert.ok(matchQuery("no env", "no-env"),
      "'no env' matches 'no-env' because spaces are ignored for matching");
  });

  it("a whitespace-only query matches everything", () => {
    assert.ok(matchQuery(" ", "x"), "a single space strips to empty → matches");
    assert.ok(matchQuery("   ", "anything"),
      "all-spaces query strips to empty → matches");
  });
});

// ── filterSection ───────────────────────────────────────────────────

describe("filterSection", () => {
  it("empty query returns all asserts in original order with score 0", () => {
    const a = makeAssert("alpha");
    const b = makeAssert("beta");
    const out = filterSection("", [a, b]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.assert, a);
    assert.equal(out[1]!.assert, b);
    assert.equal(out[0]!.result.score, 0);
  });

  it("whitespace-only query returns all asserts (strip → empty)", () => {
    const a = makeAssert("alpha");
    const b = makeAssert("beta");
    const out = filterSection("   ", [a, b]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.assert, a);
    assert.equal(out[1]!.assert, b);
  });

  it("filters to matching asserts", () => {
    const a = makeAssert("write-guard");
    const b = makeAssert("no-env");
    const out = filterSection("env", [a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.assert, b);
  });

  it("ranks best-first within the section", () => {
    const write = makeAssert("write-guard", { description: "forbids env leaks" });
    const env = makeAssert("no-env", { description: "unrelated" });
    const out = filterSection("env", [write, env]);
    // 'no-env' matches in name (tier 40 000); 'write-guard' only in
    // description (tier 30 000). Name wins.
    assert.equal(out.length, 2);
    assert.equal(out[0]!.assert, env);
    assert.equal(out[1]!.assert, write);
  });

  it("tier dominance: name outranks description regardless of fuzz", () => {
    // 'description-only' matches PERFECTLY (all-contiguous, boundary) in
    // description but not in name; 'x' matches in name but poorly.
    const perfectDesc = makeAssert("zzz", {
      description: "env",          // contiguous + boundary, max fuzz
    });
    const poorName = makeAssert("env", {   // name is exactly 'env'
      description: "unrelated",
    });
    const out = filterSection("env", [perfectDesc, poorName]);
    assert.equal(out[0]!.assert, poorName,
      "a name match (tier 40 000) outranks a perfect description match (≤ 39 999)");
  });

  it("tier dominance: description outranks source", () => {
    const descMatch = makeAssert("x", { description: "env" });
    const sourceMatch = makeAssert("y", { source: "owner/env-tools" });
    const out = filterSection("env", [descMatch, sourceMatch]);
    assert.equal(out[0]!.assert, descMatch,
      "description (tier 30 000) outranks source (tier 20 000)");
  });

  it("tier dominance: source outranks shell", () => {
    const sourceMatch = makeAssert("x", { source: "owner/env-tools" });
    const shellMatch = makeAssert("y", { shell: "grep env .env" });
    const out = filterSection("env", [sourceMatch, shellMatch]);
    assert.equal(out[0]!.assert, sourceMatch,
      "source (tier 20 000) outranks shell (tier 10 000)");
  });

  it("is stable on ties (original within-section order preserved)", () => {
    // Two asserts that tie: identical name prefix match quality. Ties must
    // keep their original section order.
    const first = makeAssert("aaa-env");
    const second = makeAssert("bbb-env");
    const out = filterSection("env", [first, second]);
    assert.equal(out[0]!.assert, first);
    assert.equal(out[1]!.assert, second);
  });

  it("does not throw when description/when are absent (test-constructed)", () => {
    // makeAssert sets description:"" by default here; verify an assert
    // built with the panel-test helper shape (description omitted entirely
    // on the type but present as undefined) still ranks.
    const a: Assert = {
      name: "no-env",
      source: "local",
      hook: "tool_call",
      shell: "true",
      default: false,
      // description intentionally omitted
    } as unknown as Assert;
    const out = filterSection("env", [a]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.assert, a);
  });

  it("matches against the `when` field", () => {
    const a = makeAssert("x", { when: "test -f ./env" });
    const out = filterSection("env", [a]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.assert, a);
  });

  it("0-clamp excludes asserts whose only field hits a dead path", () => {
    // 'osc-rule' has 'g','i','t' only as spread across a long shell with
    // gaps ~60. The weak shell hit 0-clamps → no field contributes → the
    // assert drops out of the section entirely (the "too fuzzy" fix).
    const gitGuard = makeAssert("git-guard");
    const osc = makeAssert("osc-rule", {
      shell: "echo g" + "x".repeat(60) + "i" + "x".repeat(60) + "t",
    });
    const out = filterSection("git", [gitGuard, osc]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.assert, gitGuard,
      "only the tight git-guard survives; osc's dead-path shell match is dropped");
  });

  it("excludes asserts that match no field", () => {
    const a = makeAssert("write-guard");
    const b = makeAssert("no-secrets");
    const out = filterSection("zzz", [a, b]);
    assert.equal(out.length, 0);
  });
});