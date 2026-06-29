/**
 * Tests for AssertsPanel rendering / keyboard navigation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AssertsPanel } from "../pi-assert/ui/asserts.js";
import type { AssertsState } from "../pi-assert/ui/state.js";
import type { Assert } from "../pi-assert/engine.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

/** A theme that wraps accented text in brackets so assertions can see it. */
function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) =>
      role === "accent" ? `[${text}]` : text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function makeAssert(
  name: string,
  source = "local",
  isDefault = false,
  opts: { shell?: string; when?: string } = {},
): Assert {
  return {
    name,
    source,
    hook: "tool_call",
    shell: opts.shell ?? "true",
    when: opts.when,
    default: isDefault,
    path: `/tmp/${name}.json`,
  };
}

function makePanel(asserts: Assert[], active: Set<string> = new Set()): AssertsPanel {
  const state = {
    asserts,
    active,
  } as unknown as AssertsState;

  const panel = new AssertsPanel(state);
  panel.setTheme(mockTheme());
  return panel;
}

/** Minimal ExtensionContext mock for handleInput tests. */
function makeCtx(): ExtensionContext {
  return {
    ui: {
      notify() {},
      theme: mockTheme(),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
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
      3,
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

  it("renders the selected assert's shell command in the detail panel", () => {
    const panel = makePanel([
      makeAssert("alpha", "local", false, { shell: "echo hello" }),
      makeAssert("beta"),
    ]);

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("shell:") && l.includes("echo hello")),
      "shows the shell command for the highlighted assert",
    );
  });

  it("renders the when precondition when present", () => {
    const panel = makePanel([
      makeAssert("alpha", "local", false, {
        shell: "echo hello",
        when: "test -f ./flag",
      }),
    ]);

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("when:") && l.includes("test -f ./flag")),
      "shows the when precondition",
    );
  });

  it("omits the when line when the assert has no when precondition", () => {
    const panel = makePanel([
      makeAssert("alpha", "local", false, { shell: "echo hello" }),
    ]);

    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("when:")),
      "does not show a when line when absent",
    );
  });

  it("wraps long shell commands in the detail panel", () => {
    const longShell =
      "echo one two three four five six seven eight nine ten eleven twelve";
    const panel = makePanel([
      makeAssert("alpha", "local", false, { shell: longShell }),
    ]);

    const lines = panel.render(40);
    assert.ok(
      lines.some((l) => l.includes("shell:") && l.includes("echo")),
      "first detail line shows the shell label",
    );
    assert.ok(
      lines.some((l) => !l.includes("shell:") && l.includes("twelve")),
      "wrapped continuation line appears",
    );
  });

  it("updates the detail panel when the selection moves", () => {
    const panel = makePanel([
      makeAssert("alpha", "local", false, { shell: "echo alpha" }),
      makeAssert("beta", "local", false, { shell: "echo beta" }),
    ]);

    let lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("echo alpha")),
      "initial detail shows alpha's shell",
    );
    assert.ok(
      !lines.some((l) => l.includes("echo beta")),
      "beta's shell is not shown yet",
    );

    panel.nav.moveWithin("down");
    lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("echo beta")),
      "detail updates to beta's shell after moving down",
    );
  });

  // ── Hint line ───────────────────────────────────────────────────

  it("shows the d Disable all hint when asserts are active", () => {
    const panel = makePanel([makeAssert("alpha")], new Set(["alpha"]));
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("Disable all")),
      "shows Disable all when an assert is active",
    );
    assert.ok(
      lines.some((l) => l.includes("[d]")),
      "Disable all is bound to the d key",
    );
  });

  it("hides the d Disable all hint when nothing is active", () => {
    const panel = makePanel([makeAssert("alpha")]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("Disable all")),
      "hides Disable all when nothing is active",
    );
  });

  it("binds Remove to r (not d) for non-local asserts", () => {
    const panel = makePanel([makeAssert("alpha", "repo/owner")]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("[r] Remove")),
      "Remove is bound to r for non-local asserts",
    );
    assert.ok(
      !lines.some((l) => l.includes("[d] Remove")),
      "Remove is no longer bound to d",
    );
  });

  // ── d / r keybindings ───────────────────────────────────────────

  it("d clears the active set and persists", () => {
    const active = new Set(["alpha", "beta"]);
    let persisted = false;
    let statusUpdated = false;
    const state = {
      asserts: [makeAssert("alpha"), makeAssert("beta")],
      active,
      disableAll() { active.clear(); },
      persist() { persisted = true; },
      updateStatus() { statusUpdated = true; },
    } as unknown as AssertsState;

    const panel = new AssertsPanel(state);
    panel.setTheme(mockTheme());

    panel.handleInput("d", makeCtx());

    assert.equal(active.size, 0, "active set is cleared");
    assert.ok(persisted, "persist is called");
    assert.ok(statusUpdated, "status bar is refreshed");
  });

  it("d is a no-op when nothing is active (no persist)", () => {
    let persisted = false;
    const state = {
      asserts: [makeAssert("alpha")],
      active: new Set<string>(),
      disableAll() { /* should not run */ },
      persist() { persisted = true; },
      updateStatus() { },
    } as unknown as AssertsState;

    const panel = new AssertsPanel(state);
    panel.setTheme(mockTheme());

    panel.handleInput("d", makeCtx());

    assert.ok(!persisted, "must not persist an empty active set");
  });

  it("r opens the remove confirm for a non-local assert", () => {
    const panel = makePanel([makeAssert("alpha", "repo/owner")]);
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "alpha"? y/n`)),
      "r opens the remove confirm dialog",
    );
  });
});
