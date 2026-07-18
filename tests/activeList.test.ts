/**
 * Tests for `AssertsState.activeList()` — the single place that produces "the
 * asserts that should run".  Active shell asserts pass through; active presets
 * expand to their referenced shell asserts (deduped by `source\x00name`).
 *
 * Dangling refs (a `source/name` that isn't installed) are silent at runtime;
 * nested presets (a preset ref → another preset) are skipped (no nested
 * presets for v1).  Refs split on the **last** `/`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AssertsState } from "../pi-assert/ui/state.js";
import type { Assert, ShellAssert } from "../pi-assert/engine.js";

/** Minimal mock — `activeList()` only reads `asserts`/`active`, not `pi`. */
function makeState(asserts: Assert[], active: Set<string>): AssertsState {
  const state = new AssertsState({} as unknown as ExtensionAPI);
  state.asserts = asserts;
  state.active = active;
  return state;
}

/** A shell assert. */
function shell(
  source: string,
  name: string,
  hook = "tool_call",
  shellCmd = "true",
): ShellAssert {
  return {
    name,
    source,
    description: "d",
    hook,
    shell: shellCmd,
    default: false,
  };
}

/** A preset referencing `refs`. */
function preset(source: string, name: string, refs: string[]): Assert {
  return { name, source, description: "d", preset: refs, default: false };
}

/** Active names (bare) from the result, in order. */
function names(asserts: Assert[]): string[] {
  return asserts.map((a) => a.name);
}

// ---------------------------------------------------------------------------

describe("activeList — shell asserts", () => {
  it("returns active shell asserts (inactive ones dropped)", () => {
    const state = makeState(
      [shell("local", "a"), shell("local", "b")],
      new Set(["a"]),
    );
    const out = state.activeList();
    assert.deepEqual(names(out), ["a"]);
  });

  it("preserves declaration order", () => {
    const state = makeState(
      [shell("local", "a"), shell("local", "b"), shell("local", "c")],
      new Set(["a", "b", "c"]),
    );
    assert.deepEqual(names(state.activeList()), ["a", "b", "c"]);
  });
});

describe("activeList — source-qualified activation", () => {
  it("enables same-named entries independently", () => {
    const state = makeState(
      [shell("local", "guard"), shell("owner/repo", "guard")],
      new Set(["local\x00guard"]),
    );
    assert.deepEqual(
      state.activeList().map((a) => `${a.source}/${a.name}`),
      ["local/guard"],
    );
  });

  it("does not migrate an ambiguous legacy bare name", () => {
    const state = makeState(
      [shell("local", "guard"), shell("owner/repo", "guard")],
      new Set(["guard"]),
    );
    assert.deepEqual(state.activeList(), []);
  });
});

describe("activeList — preset expansion", () => {
  it("expands a local/name ref to the referenced shell assert", () => {
    const state = makeState(
      [shell("local", "guard"), preset("local", "bundle", ["local/guard"])],
      new Set(["bundle"]),
    );
    assert.deepEqual(names(state.activeList()), ["guard"]);
  });

  it("expands an owner/repo/name ref (split on last slash)", () => {
    const state = makeState(
      [
        shell("meffmadd/pi-assert-rules", "protect-env"),
        preset("local", "bundle", ["meffmadd/pi-assert-rules/protect-env"]),
      ],
      new Set(["bundle"]),
    );
    assert.deepEqual(names(state.activeList()), ["protect-env"]);
  });

  it("expands multiple refs in declared order", () => {
    const state = makeState(
      [
        shell("local", "a"),
        shell("local", "b"),
        preset("local", "bundle", ["local/a", "local/b"]),
      ],
      new Set(["bundle"]),
    );
    assert.deepEqual(names(state.activeList()), ["a", "b"]);
  });

  it("mixes local and repo refs across sources", () => {
    const state = makeState(
      [
        shell("local", "a"),
        shell("owner/repo", "b"),
        preset("local", "bundle", ["local/a", "owner/repo/b"]),
      ],
      new Set(["bundle"]),
    );
    assert.deepEqual(names(state.activeList()), ["a", "b"]);
  });

  it("inactive preset contributes nothing", () => {
    const state = makeState(
      [shell("local", "a"), preset("local", "bundle", ["local/a"])],
      new Set(["a"]),
    );
    // `a` is active individually; the preset is inactive → just `a`.
    assert.deepEqual(names(state.activeList()), ["a"]);
  });

  it("empty preset contributes nothing", () => {
    const state = makeState(
      [shell("local", "a"), preset("local", "bundle", [])],
      new Set(["bundle"]),
    );
    assert.deepEqual(names(state.activeList()), []);
  });
});

describe("activeList — dedup", () => {
  it("an assert active individually and via a preset runs once", () => {
    const state = makeState(
      [shell("local", "a"), preset("local", "bundle", ["local/a"])],
      new Set(["a", "bundle"]),
    );
    assert.deepEqual(names(state.activeList()), ["a"]);
  });

  it("two presets referencing the same member run it once", () => {
    const state = makeState(
      [
        shell("local", "a"),
        preset("local", "p1", ["local/a"]),
        preset("local", "p2", ["local/a"]),
      ],
      new Set(["p1", "p2"]),
    );
    assert.deepEqual(names(state.activeList()), ["a"]);
  });

  it("dedups by source\\x00name (same name, different sources = distinct)", () => {
    const state = makeState(
      [
        shell("local", "dup"),
        shell("owner/repo", "dup"),
        preset("local", "bundle", ["local/dup", "owner/repo/dup"]),
      ],
      new Set(["bundle"]),
    );
    // Two distinct asserts (different sources) despite the shared name.
    const out = state.activeList();
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((a) => `${a.source}/${a.name}`),
      ["local/dup", "owner/repo/dup"],
    );
  });
});

describe("activeList — dangling & nested refs", () => {
  it("dangling ref (not installed) is silent — contributes nothing", () => {
    const state = makeState(
      [
        shell("local", "a"),
        preset("local", "bundle", ["local/a", "local/missing"]),
      ],
      new Set(["bundle"]),
    );
    assert.deepEqual(names(state.activeList()), ["a"]);
  });

  it("all-dangling preset is inert (expands to nothing)", () => {
    const state = makeState(
      [preset("local", "bundle", ["local/x", "owner/repo/y"])],
      new Set(["bundle"]),
    );
    assert.deepEqual(names(state.activeList()), []);
  });

  it("nested preset ref (preset → another preset) is skipped", () => {
    const state = makeState(
      [
        shell("local", "a"),
        // inner references a real shell assert; outer references inner (a preset).
        preset("local", "inner", ["local/a"]),
        preset("local", "outer", ["local/inner"]),
      ],
      new Set(["outer"]),
    );
    // `outer` → `inner` (a preset) → skipped (no nested presets for v1).
    assert.deepEqual(names(state.activeList()), []);
  });

  it("nested preset ref skipped, but a sibling shell ref still expands", () => {
    const state = makeState(
      [
        shell("local", "a"),
        preset("local", "inner", ["local/a"]),
        preset("local", "outer", ["local/inner", "local/a"]),
      ],
      new Set(["outer"]),
    );
    // `local/inner` skipped (nested preset), `local/a` expands → ["a"].
    assert.deepEqual(names(state.activeList()), ["a"]);
  });
});
