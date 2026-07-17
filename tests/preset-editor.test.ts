/**
 * Tests for `PresetEditorPanel` — the preset editor's sectioned, searchable
 * assert picker.  Behaves like the `/asserts` view (sections by source,
 * fzf-style search, Tab/Shift+Tab cross-section navigation) but with checkbox
 * semantics: `Enter` toggles membership (`✓`), `Esc` commits + goes back.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PresetEditorPanel } from "../pi-assert/ui/preset-editor.js";
import type { Assert } from "../pi-assert/engine.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const SPACE = " ";
const TAB = "\t";

/** A theme that wraps accented text in brackets so assertions can see it. */
function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) =>
      role === "accent" ? `[${text}]` : role === "success" ? `{${text}}` : text,
    bold: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function makeAssert(
  name: string,
  source = "local",
  opts: { shell?: string; when?: string; description?: string } = {},
): Assert {
  return {
    name,
    source,
    description: opts.description ?? `desc-${name}`,
    hook: "tool_call",
    shell: opts.shell ?? "true",
    when: opts.when,
    default: false,
    path: `/tmp/${name}.json`,
  };
}

function makePanel(
  shellAsserts: Assert[],
  selected: Set<string> = new Set(),
  opts: { name?: string; description?: string } = {},
): PresetEditorPanel {
  const panel = new PresetEditorPanel(
    shellAsserts,
    opts.name ?? "my-preset",
    opts.description ?? "A preset.",
    selected,
  );
  panel.setTheme(mockTheme());
  return panel;
}

/** Strip the mock theme's `[]` accent and `{}` success wrappers. */
function plain(s: string): string {
  return s.replace(/[\[\]{}]/g, "");
}

/** The focused row (starts with the accent-wrapped `> `). */
function focusedLine(lines: string[]): string | undefined {
  return lines.find((l) => plain(l).startsWith("> "));
}

// ═══════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel rendering", () => {
  it("groups shell asserts by source (local first, then repos alpha)", () => {
    const panel = makePanel([
      makeAssert("zeta", "owner/repo"),
      makeAssert("alpha", "local"),
      makeAssert("beta", "owner/repo"),
    ]);
    const lines = panel.render(80);
    // Section headers may carry `Tab`/`Shift+Tab` jump-key hints after the
    // label (2-space separator); split them off to get the bare source.
    const sources = lines
      .map((l) => plain(l).trim().split(/\s{2,}/)[0])
      .filter((s) => s === "Local" || s === "owner/repo");
    // Local section first, then the repo.
    assert.deepEqual(sources, ["Local", "owner/repo"]);
  });

  it("renders a ✓ badge for selected (member) asserts and a space for others", () => {
    const panel = makePanel(
      [makeAssert("alpha"), makeAssert("beta")],
      new Set(["local/alpha"]),
    );
    const lines = panel.render(80);
    const alphaLine = lines.find((l) => plain(l).includes("alpha"))!;
    const betaLine = lines.find((l) => plain(l).includes("beta"))!;
    assert.ok(plain(alphaLine).includes("✓"), "alpha (member) has ✓");
    assert.ok(!plain(betaLine).includes("✓"), "beta (non-member) has no ✓");
  });

  it("shows the preset name + description in the header", () => {
    const panel = makePanel([makeAssert("a")], new Set(), {
      name: "my-preset",
      description: "Guards writes.",
    });
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("Edit preset") && plain(l).includes("my-preset")),
      "header shows title + name",
    );
    assert.ok(
      lines.some((l) => plain(l).includes("Guards writes.")),
      "header shows description",
    );
  });

  it("renders shell/when detail under the focused row", () => {
    const panel = makePanel([makeAssert("a", "local", { shell: "git status", when: "true" })]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("shell: git status")),
      "detail shows shell",
    );
    assert.ok(
      lines.some((l) => plain(l).includes("when: true")),
      "detail shows when",
    );
  });

  it("shows 'No shell asserts to select' when empty", () => {
    const panel = makePanel([]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("No shell asserts to select")),
      "empty state message",
    );
  });

  it("excludes presets from the picker (only shell asserts offered)", () => {
    const preset = {
      name: "other-preset",
      source: "local",
      description: "d",
      preset: ["local/guard"],
      default: false,
      path: "/tmp/p.json",
    } as unknown as Assert;
    const shell = makeAssert("guard");
    const panel = makePanel([shell, preset]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => plain(l).includes("other-preset")),
      "preset is not in the picker",
    );
    assert.ok(
      lines.some((l) => plain(l).includes("guard")),
      "shell assert is in the picker",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Enter toggle
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel Enter toggle", () => {
  it("Enter adds the focused assert to the selection", () => {
    const panel = makePanel([makeAssert("alpha")]);
    assert.deepEqual(panel.value, []);
    panel.handleInput(ENTER);
    assert.deepEqual(panel.value, ["local/alpha"]);
  });

  it("Enter removes an already-selected focused assert", () => {
    const panel = makePanel([makeAssert("alpha")], new Set(["local/alpha"]));
    assert.deepEqual(panel.value, ["local/alpha"]);
    panel.handleInput(ENTER);
    assert.deepEqual(panel.value, []);
  });

  it("Enter toggles without committing (returns undefined)", () => {
    const panel = makePanel([makeAssert("alpha")]);
    const result = panel.handleInput(ENTER);
    assert.strictEqual(result, undefined);
  });

  it("Space is a no-op in normal mode (not a toggle)", () => {
    const panel = makePanel([makeAssert("alpha")]);
    panel.handleInput(SPACE);
    assert.deepEqual(panel.value, [], "Space did not toggle");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Esc commit
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel commit", () => {
  it("Esc commits the current selection in item order", () => {
    const panel = makePanel(
      [makeAssert("a"), makeAssert("b"), makeAssert("c")],
      new Set(),
    );
    // Toggle a (focused first), then down to b and toggle b.
    panel.handleInput(ENTER); // a
    panel.handleInput(DOWN);
    panel.handleInput(ENTER); // b
    const result = panel.handleInput(ESC); // Esc commits + back
    assert.deepEqual(result, { value: ["local/a", "local/b"], index: 1 });
  });

  it("Esc commits the working selection (not cancel)", () => {
    const panel = makePanel([makeAssert("a")], new Set(["local/a"]));
    const result = panel.handleInput(ESC);
    assert.deepEqual(result, { value: ["local/a"], index: 0 });
  });

  it("Esc in search exits search (not commit)", () => {
    const panel = makePanel([makeAssert("alpha"), makeAssert("beta")]);
    panel.handleInput("/");
    assert.ok(panel.isSearchActive, "search entered");
    const result = panel.handleInput(ESC);
    assert.strictEqual(result, undefined, "Esc exits search, no result");
    assert.ok(!panel.isSearchActive, "search exited");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel search", () => {
  it("/ enters search, typing filters, Esc exits", () => {
    const panel = makePanel([makeAssert("alpha"), makeAssert("beta"), makeAssert("gamma")]);
    panel.handleInput("/");
    assert.ok(panel.isSearchActive);
    panel.handleInput("alp"); // matches alpha's name only (not "local" source)
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("alpha")), "alpha matches");
    assert.ok(!lines.some((l) => plain(l).includes("beta")), "beta filtered out");
    assert.ok(!lines.some((l) => plain(l).includes("gamma")), "gamma filtered out");
    panel.handleInput(ESC); // Esc exits
    assert.ok(!panel.isSearchActive);
  });

  it("Enter toggles in search mode (not a query char)", () => {
    const panel = makePanel([makeAssert("alpha"), makeAssert("beta")]);
    panel.handleInput("/");
    panel.handleInput("al"); // matches alpha
    panel.handleInput(ENTER); // toggle — not append to query
    assert.deepEqual(panel.value, ["local/alpha"], "Enter toggled the focused match");
  });

  it("Enter toggles in search mode (does not commit)", () => {
    const panel = makePanel([makeAssert("alpha"), makeAssert("beta")]);
    panel.handleInput("/");
    panel.handleInput("al");
    const result = panel.handleInput(ENTER);
    assert.strictEqual(result, undefined, "Enter toggles, does not commit");
    assert.deepEqual(panel.value, ["local/alpha"], "toggled the focused match");
  });

  it("Space feeds the query in search mode (not a toggle)", () => {
    const panel = makePanel([makeAssert("alpha")]);
    panel.handleInput("/");
    panel.handleInput("al"); // matches alpha
    panel.handleInput(SPACE); // Space is a query char, not a toggle
    const lines = panel.render(80);
    // The /query line shows the space appended (mock theme wraps accent in []).
    const queryLine = lines.find((l) => plain(l).includes("/al "));
    assert.ok(queryLine, "Space appended to the query (shown in the /query line)");
    assert.deepEqual(panel.value, [], "Space did not toggle");
  });

  it("shows 'No matches' when the query matches nothing", () => {
    const panel = makePanel([makeAssert("alpha")]);
    panel.handleInput("/");
    panel.handleInput("z");
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("No matches")));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel navigation", () => {
  it("down moves focus within a section", () => {
    const panel = makePanel([makeAssert("a"), makeAssert("b"), makeAssert("c")]);
    panel.handleInput(DOWN);
    const lines = panel.render(80);
    const focused = focusedLine(lines);
    assert.ok(focused && plain(focused).includes("b"), "focus moved to b");
  });

  it("down at a section boundary crosses to the next section", () => {
    const panel = makePanel([
      makeAssert("a", "local"),
      makeAssert("b", "owner/repo"),
    ]);
    panel.handleInput(DOWN); // a is last in local → cross to b in owner/repo
    const lines = panel.render(80);
    const focused = focusedLine(lines);
    assert.ok(focused && plain(focused).includes("b"), "crossed to next section");
  });

  it("Tab cycles to the next section", () => {
    const panel = makePanel([
      makeAssert("a", "local"),
      makeAssert("b", "owner/repo"),
    ]);
    panel.handleInput(TAB); // Tab → next section
    const lines = panel.render(80);
    const focused = focusedLine(lines);
    assert.ok(focused && plain(focused).includes("b"), "Tab moved to next section");
  });

  it("section headers show Tab/Shift+Tab jump-key hints (shared with /asserts)", () => {
    const panel = makePanel([
      makeAssert("a", "local"),
      makeAssert("b", "owner/repo"),
    ]);
    // Focused on Local (index 0): the next section (owner/repo) shows `Tab`.
    let lines = panel.render(80);
    const repoHeader = lines.find((l) => plain(l).trim().startsWith("owner/repo"))!;
    assert.ok(repoHeader, "owner/repo header renders");
    assert.ok(
      plain(repoHeader).includes("Tab"),
      "next-section header shows the Tab jump-key hint",
    );
    // Tab to owner/repo: the previous section (Local) now shows `Shift+Tab`.
    panel.handleInput(TAB);
    lines = panel.render(80);
    const localHeader = lines.find((l) => plain(l).trim().startsWith("Local"))!;
    assert.ok(localHeader, "Local header renders");
    assert.ok(
      plain(localHeader).includes("Shift+Tab"),
      "prev-section header shows the Shift+Tab jump-key hint",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Hint line
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel hint", () => {
  it("renders Enter/search/Esc hint in normal mode", () => {
    const panel = makePanel([makeAssert("a")]);
    const lines = panel.render(80);
    const hint = lines.find((l) => plain(l).includes("toggle"))!;
    assert.ok(hint, "hint line exists");
    assert.ok(plain(hint).includes("Enter"), "Enter in hint");
    assert.ok(plain(hint).includes("search"), "search in hint");
    assert.ok(plain(hint).includes("Esc"), "Esc in hint");
    assert.ok(!plain(hint).includes("Space"), "Space not in hint");
  });
});
