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

  it("windows a long active section when terminal height is constrained", () => {
    const panel = makePanel(
      Array.from({ length: 8 }, (_, i) => makeAssert(`a-${i}`)),
    );

    const lines = panel.render(80, 12);
    const activeHeader = lines.find((l) => l.includes("[Local]"));

    assert.ok(activeHeader, "active section header is shown");
    assert.equal(
      lines.filter((l) => l.includes("a-")).length,
      4,
      "shows a windowed view of the asserts",
    );
    assert.ok(
      lines.some((l) => l.includes("a-0")),
      "selected assert stays visible",
    );
    assert.ok(
      !lines.some((l) => l.includes("a-7")),
      "asserts outside the window are hidden",
    );
    assert.ok(
      lines.some((l) => l.includes("(1/8)")),
      "shows scroll indicator",
    );
  });

  it("centers the active window around the selected assert", () => {
    const panel = makePanel(
      Array.from({ length: 8 }, (_, i) => makeAssert(`a-${i}`)),
    );

    // Move selection to the 7th assert (index 6)
    for (let i = 0; i < 6; i++) panel.nav.moveWithin("down");

    const lines = panel.render(80, 12);
    assert.ok(
      lines.some((l) => l.includes("a-6")),
      "selected assert a-6 is visible",
    );
    assert.ok(
      !lines.some((l) => l.includes("a-0")),
      "top asserts are scrolled out",
    );
    assert.ok(
      lines.some((l) => l.includes("(7/8)")),
      "scroll indicator follows selection",
    );
  });

  it("always shows inactive section headers around the active anchor", () => {
    const panel = makePanel([
      makeAssert("above-1", "repo/aaa"),
      makeAssert("active-1", "repo/mid"),
      makeAssert("active-2", "repo/mid"),
      makeAssert("below-1", "repo/zzz"),
    ]);

    // Move focus from the first section down to the middle section.
    panel.nav.cross("down");

    const lines = panel.render(80, 17);

    assert.ok(
      lines.some((l) => l.includes("repo/aaa")),
      "shows header of section above",
    );
    assert.ok(
      lines.some((l) => l.includes("active-1")),
      "shows active section asserts",
    );
    assert.ok(
      lines.some((l) => l.includes("repo/zzz")),
      "shows header of section below",
    );
    assert.ok(
      !lines.some((l) => l.includes("above-1")),
      "does not render asserts of inactive sections",
    );
    assert.ok(
      !lines.some((l) => l.includes("below-1")),
      "does not render asserts of inactive sections",
    );
  });

  it("renders inactive section headers but not their asserts", () => {
    const panel = makePanel([
      ...Array.from({ length: 2 }, (_, i) => makeAssert(`active-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => makeAssert(`below-${i}`, "repo/below")),
    ]);

    const lines = panel.render(80, 14);

    assert.ok(
      lines.some((l) => l.includes("active-0")),
      "shows active section asserts",
    );
    assert.ok(
      lines.some((l) => l.includes("repo/below")),
      "shows inactive section header",
    );
    assert.ok(
      !lines.some((l) => l.includes("below-0")),
      "does not render asserts of inactive sections",
    );
  });

  it("shows adjacent section headers even when vertical space is tight", () => {
    const panel = makePanel([
      makeAssert("above-1", "repo/aaa"),
      ...Array.from({ length: 10 }, (_, i) => makeAssert(`active-${i}`, "repo/mid")),
      makeAssert("below-1", "repo/zzz"),
    ]);

    panel.nav.cross("down");

    const lines = panel.render(80, 12);

    assert.ok(
      lines.some((l) => l.includes("repo/aaa")),
      "shows header of section above even when tight",
    );
    assert.ok(
      lines.some((l) => l.includes("repo/zzz")),
      "shows header of section below even when tight",
    );
    assert.ok(
      lines.some((l) => l.includes("active-0")),
      "shows at least one active assert",
    );
    assert.ok(
      lines.some((l) => l.includes("(1/10)")),
      "shows scroll indicator because active section is windowed",
    );
  });

  it("always renders the Asserts header as the first line", () => {
    const panel = makePanel(
      Array.from({ length: 8 }, (_, i) => makeAssert(`a-${i}`)),
    );

    for (const h of [5, 8, 10, 12, 15, 20, undefined]) {
      const lines = panel.render(80, h);
      assert.ok(
        lines[0]?.includes("Asserts"),
        `first line should be header for terminalHeight=${String(h)}`,
      );
    }
  });
});
