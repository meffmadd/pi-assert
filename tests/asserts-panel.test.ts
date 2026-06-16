/**
 * Tests for AssertsPanel rendering / keyboard navigation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AssertsPanel } from "../pi-assert/ui/asserts.js";
import type { AssertsState } from "../pi-assert/ui/state.js";
import type { Assert } from "../pi-assert/engine.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

/** A theme that wraps accented text in brackets so assertions can see it. */
function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) =>
      role === "accent" ? `[${text}]` : text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function makeAssert(name: string, source = "local", isDefault = false): Assert {
  return {
    name,
    source,
    hook: "tool_call",
    shell: "true",
    default: isDefault,
    path: `/tmp/${name}.json`,
  };
}

function makePanel(asserts: Assert[]): AssertsPanel {
  const state = {
    asserts,
    active: new Set<string>(),
  } as unknown as AssertsState;

  const panel = new AssertsPanel(state);
  panel.setTheme(mockTheme());
  return panel;
}

/** Extract the currently highlighted assert row. */
function focusedLine(lines: string[]): string | undefined {
  return lines.find((line) => line.startsWith("[> "));
}

// ── Tests ─────────────────────────────────────────────────────────

describe("AssertsPanel", () => {
  it("highlights the first item initially", () => {
    const panel = makePanel([
      makeAssert("alpha"),
      makeAssert("beta"),
      makeAssert("gamma"),
    ]);

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][alpha]  [disabled]");
  });

  it("moves the highlight down on arrow down", () => {
    const panel = makePanel([
      makeAssert("alpha"),
      makeAssert("beta"),
      makeAssert("gamma"),
    ]);

    // Move down
    panel.nav.moveWithin("down");

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][beta ]  [disabled]");
    assert.ok(
      lines.some((line) => line.includes("alpha") && !line.startsWith("[> ][alpha]")),
      "previous item should no longer be highlighted",
    );
  });

  it("moves the highlight up on arrow up", () => {
    const panel = makePanel([
      makeAssert("alpha"),
      makeAssert("beta"),
      makeAssert("gamma"),
    ]);

    panel.nav.moveWithin("down");
    panel.nav.moveWithin("down");
    panel.nav.moveWithin("up");

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][beta ]  [disabled]");
  });

  it("aligns values when default tag makes labels uneven", () => {
    const panel = makePanel([
      makeAssert("short"),
      makeAssert("longname", "local", true),
    ]);

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][short             ]  [disabled]");
  });
});
