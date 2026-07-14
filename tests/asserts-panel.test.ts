/**
 * Tests for AssertsPanel rendering / keyboard navigation.
 */

import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";

import { AssertsPanel } from "../pi-assert/ui/asserts.js";
import type { AssertsState } from "../pi-assert/ui/state.js";
import type { Assert } from "../pi-assert/engine.js";
import { clearRepoEntriesCache } from "../pi-assert/installer.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

/** A theme that wraps accented text in brackets so assertions can see it. */
function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) =>
      role === "accent" ? `[${text}]` : text,
    bold: (text: string) => text,
    underline: (text: string) => text,
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

/** A preset referencing `refs` (qualified `source/name` refs). */
function makePreset(
  name: string,
  refs: string[],
  source = "local",
  isDefault = false,
): Assert {
  return {
    name,
    source,
    description: "d",
    preset: refs,
    default: isDefault,
    path: `/tmp/${name}.json`,
  };
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

/** Strip the mock theme's `[]` accent wrappers so substring checks survive per-char highlighting. */
function plain(s: string): string {
  return s.replace(/[\[\]]/g, "");
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

    assert.equal(highlighted, "[> ][alpha]  disabled");
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

    assert.equal(highlighted, "[> ][beta ]  disabled");
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

    assert.equal(highlighted, "[> ][beta ]  disabled");
  });

  it("aligns values when default tag makes labels uneven", () => {
    const panel = makePanel([
      makeAssert("short"),
      makeAssert("longname", "local", true),
    ]);

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][short             ]  disabled");
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

  it("binds Remove to r (not d)", () => {
    const panel = makePanel([makeAssert("alpha", "repo/owner")]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("[r] Remove")),
      "Remove is bound to r",
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
      lines.some((l) => l.includes(`Remove "alpha"?`)),
      "r opens the remove confirm dialog",
    );
  });

  it("r opens the remove confirm for a local assert too", () => {
    const panel = makePanel([makeAssert("alpha")]);
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "alpha"?`)),
      "r opens the remove confirm for local asserts (no notify gate)",
    );
  });

  it("shows the Remove hint for a local section", () => {
    const panel = makePanel([makeAssert("alpha")]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("[r] Remove")),
      "the Remove hint appears for local sections too",
    );
  });

  it("remove confirm shows a y/n keybinding hint", () => {
    const panel = makePanel([makeAssert("alpha", "repo/owner")]);
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => /y.*confirm/.test(l) && /n.*cancel/.test(l)),
      "confirm renders the y/n hint (matches the install flow)",
    );
  });

  // Structural guard: `render` is the single emission point that always tails
  // the output with a hint line, so no mode (empty / confirm / bounded /
  // unbounded) can forget the hint — the regression that prompted this.
  it("every render mode ends with a hint line", () => {
    const panel = makePanel([
      makeAssert("alpha", "repo/owner"),
      makeAssert("beta", "repo/owner"),
    ]);
    const isHint = (l: string) =>
      /Remove|Esc|Install|enable|Toggle|Disable|confirm|cancel/.test(l);

    // Empty panel.
    assert.ok(
      isHint([...makePanel([]).render(80, 20)].reverse().find((l) => l.trim())!),
      "empty panel ends with a hint",
    );
    // Bounded + unbounded normal.
    assert.ok(isHint([...panel.render(80, 20)].reverse().find((l) => l.trim())!),"bounded normal ends with a hint");
    assert.ok(isHint([...panel.render(80)].reverse().find((l) => l.trim())!),
      "unbounded normal ends with a hint",
    );
    // Confirm.
    panel.handleInput("r", makeCtx());
    assert.ok(
      isHint([...panel.render(80, 20)].reverse().find((l) => l.trim())!),
      "confirm ends with a hint",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Section cycling — Tab / Shift+Tab jump focus between sections
// ═══════════════════════════════════════════════════════════════════

describe("AssertsPanel section cycling (Tab/Shift+Tab)", () => {
  it("cycleSection next wraps last→first across three sections", () => {
    const panel = makePanel([
      makeAssert("local-1"),
      makeAssert("aaa-1", "repo/aaa"),
      makeAssert("zzz-1", "repo/zzz"),
    ]);
    // local → repo/aaa → repo/zzz → local (wrap)
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 1);
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 2);
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 0, "wraps last→first");
  });

  it("cycleSection prev wraps first→last", () => {
    const panel = makePanel([
      makeAssert("local-1"),
      makeAssert("aaa-1", "repo/aaa"),
      makeAssert("zzz-1", "repo/zzz"),
    ]);
    panel.nav.cycleSection("prev");
    assert.equal(panel.nav.focusedSection, 2, "wraps first→last");
    panel.nav.cycleSection("prev");
    assert.equal(panel.nav.focusedSection, 1);
  });

  it("cycleSection preserves each section's remembered row", () => {
    const panel = makePanel([
      makeAssert("local-1"),
      makeAssert("local-2"),
      makeAssert("aaa-1", "repo/aaa"),
      makeAssert("aaa-2", "repo/aaa"),
      makeAssert("aaa-3", "repo/aaa"),
    ]);
    // Walk down two rows in the local section.
    panel.nav.moveWithin("down");
    panel.nav.moveWithin("down");
    assert.equal(panel.nav.focusedIndex, 1, "local section at row 1");

    // Tab to repo/aaa (fresh section, remembers its own row 0), then back.
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 1);
    assert.equal(panel.nav.focusedIndex, 0, "repo section starts at its row 0");
    panel.nav.cycleSection("prev");
    assert.equal(panel.nav.focusedSection, 0);
    assert.equal(panel.nav.focusedIndex, 1, "local row restored after round-trip");
  });

  it("cycleSection is a no-op with a single section", () => {
    const panel = makePanel([
      makeAssert("only-1"),
      makeAssert("only-2"),
    ]);
    const moved = panel.nav.cycleSection("next");
    assert.equal(moved, false);
    assert.equal(panel.nav.focusedSection, 0, "focus unchanged");
  });

  it("Tab key moves focus to the next section", () => {
    const panel = makePanel([
      makeAssert("local-1"),
      makeAssert("aaa-1", "repo/aaa"),
      makeAssert("zzz-1", "repo/zzz"),
    ]);
    panel.handleInput("\t", makeCtx());
    assert.equal(panel.nav.focusedSection, 1, "Tab advances to next section");
  });

  it("Shift+Tab (\x1b[Z) moves focus to the previous section", () => {
    const panel = makePanel([
      makeAssert("local-1"),
      makeAssert("aaa-1", "repo/aaa"),
      makeAssert("zzz-1", "repo/zzz"),
    ]);
    // Move to the middle section first.
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 1);
    // Shift+Tab via its real escape sequence.
    panel.handleInput("\x1b[Z", makeCtx());
    assert.equal(panel.nav.focusedSection, 0, "Shift+Tab returns to previous section");
  });

  it("Tab is a no-op with a single section", () => {
    const panel = makePanel([
      makeAssert("only-1"),
      makeAssert("only-2"),
    ]);
    panel.handleInput("\t", makeCtx());
    assert.equal(panel.nav.focusedSection, 0, "focus stays on the only section");
  });

  it("Tab is ignored while a remove confirm is open", () => {
    const panel = makePanel([
      makeAssert("local-1"),
      makeAssert("aaa-1", "repo/aaa"),
    ]);
    // Open the remove confirm on the focused local assert.
    panel.handleInput("r", makeCtx());
    const focusBefore = panel.nav.focusedSection;
    panel.handleInput("\t", makeCtx());
    assert.equal(
      panel.nav.focusedSection,
      focusBefore,
      "Tab does not move focus during confirm",
    );
    // Confirm is still open (Tab didn't dismiss it).
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "local-1"?`)),
      "confirm dialog remains open after Tab",
    );
  });

  it("shows the Tab cycle hint only with more than one section", () => {
    const multi = makePanel([
      makeAssert("local-1"),
      makeAssert("aaa-1", "repo/aaa"),
    ]);
    const multiHint = multi.render(80, 20).find((l) => l.includes("Tab"));
    assert.ok(multiHint, "Tab hint shown with multiple sections");

    const single = makePanel([
      makeAssert("only-1"),
      makeAssert("only-2"),
    ]);
    const singleHint = single.render(80, 20).find((l) => l.includes("Tab"));
    assert.ok(!singleHint, "Tab hint hidden with a single section");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orphaned detection — installed asserts removed from their source repo
// ═══════════════════════════════════════════════════════════════════

/** Mock fetch helpers (mirroring install.test.ts conventions). */
function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockFileItem(path: string, content: unknown): unknown {
  const json = JSON.stringify(content);
  const b64 = Buffer.from(json).toString("base64");
  return {
    name: path.split("/").pop(),
    path,
    sha: "abc123",
    size: json.length,
    type: "file",
    content: b64,
    encoding: "base64",
  };
}

function mockTreeBlob(path: string): unknown {
  return { path, mode: "100644", type: "blob", sha: "abc123", size: 100 };
}

/**
 * Mock `fetch` so the trees call returns the given blob paths, and each
 * contents call returns the given file contents (single file).
 */
function mockRepoFetch(blobPaths: string[], fileContent: unknown): void {
  mock.method(globalThis, "fetch", (url: string) => {
    if (url.includes("/git/trees/")) {
      return mockJsonResponse({
        sha: "tree-sha",
        url,
        tree: blobPaths.map(mockTreeBlob),
        truncated: false,
      });
    }
    // contents call
    return mockJsonResponse(mockFileItem(blobPaths[0]!, fileContent));
  });
}

describe("AssertsPanel orphaned detection", () => {
  // Each test gets a fresh fetchRepoEntries cache.
  before(() => clearRepoEntriesCache());
  after(() => clearRepoEntriesCache());

  it("marks orphaned asserts with ⚠ after the fetch settles", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["rules/defaults.json"], {
      "rule-a": { description: "A.", hook: "tool_call", shell: "true" },
      "rule-b": { description: "B.", hook: "tool_call", shell: "false" },
    });

    // "rule-c" is installed but NOT in the repo → orphaned.
    const panel = makePanel([
      makeAssert("rule-a", "some/repo"),
      makeAssert("rule-c", "some/repo"),
    ]);

    let rendered = false;
    panel.setRequestRender(() => { rendered = true; });
    panel.startOrphanCheck();

    // Before the fetch settles, no ⚠ badges.
    let lines = panel.render(80);
    const ruleC = lines.find((l) => l.includes("rule-c"));
    assert.ok(ruleC, "rule-c row exists before fetch");
    assert.ok(!ruleC!.includes("⚠"), "no ⚠ before fetch settles");

    // Let the async fetch settle.
    await new Promise((r) => setImmediate(r));

    lines = panel.render(80);
    const orphanLine = lines.find((l) => l.includes("rule-c"));
    const keptLine = lines.find((l) => l.includes("rule-a"));
    assert.ok(orphanLine?.includes("⚠"), "orphaned assert gets ⚠ badge");
    assert.ok(!keptLine?.includes("⚠"), "non-orphaned assert has no ⚠");
    assert.ok(rendered, "requestRender was called when fetch settled");
  });

  it("does not mark local asserts as orphaned (no fetch)", async () => {
    clearRepoEntriesCache();
    let fetchCalled = false;
    mock.method(globalThis, "fetch", () => { fetchCalled = true; return mockJsonResponse({}); });

    const panel = makePanel([makeAssert("local-rule", "local")]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();

    await new Promise((r) => setImmediate(r));
    assert.ok(!fetchCalled, "no fetch for local-only asserts");

    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("⚠")),
      "local asserts never get ⚠",
    );
  });

  it("skips the check entirely when the config is broken", async () => {
    clearRepoEntriesCache();
    let fetchCalled = false;
    mock.method(globalThis, "fetch", () => { fetchCalled = true; return mockJsonResponse({}); });

    const state = {
      asserts: [makeAssert("rule-a", "some/repo")],
      active: new Set<string>(),
      broken: true,
    } as unknown as AssertsState;

    const panel = new AssertsPanel(state);
    panel.setTheme(mockTheme());
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();

    await new Promise((r) => setImmediate(r));
    assert.ok(!fetchCalled, "no fetch when config is broken");
  });

  it("degrades silently on network failure (no ⚠, no throw)", async () => {
    clearRepoEntriesCache();
    mock.method(globalThis, "fetch", () => {
      throw new Error("connect ECONNREFUSED");
    });

    const panel = makePanel([makeAssert("rule-a", "some/repo")]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();

    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("⚠")),
      "no ⚠ badges when fetch fails",
    );
  });

  it("aligns orphaned and non-orphaned rows (status column)", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["rules/defaults.json"], {
      "kept": { description: "K.", hook: "tool_call", shell: "true" },
    });

    // "kept" is in the repo; "orphan" is not.
    const panel = makePanel([
      makeAssert("kept", "some/repo"),
      makeAssert("orphan", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    const keptLine = lines.find((l) => l.includes("kept"))!;
    const orphanLine = lines.find((l) => l.includes("orphan"))!;

    // Strip the mock theme's `[]` accent wrappers and the `> `/`  ` prefix
    // so the comparison is on the row body only (the selected row has extra
    // `[]` chars that shift `indexOf`).
    const strip = (s: string) => s.replace(/[\[\]]/g, "").replace(/^[> ]{2}/, "");
    const keptBody = strip(keptLine);
    const orphanBody = strip(orphanLine);

    // Both rows should have "disabled" at the same column — the ⚠ badge
    // width is reserved so the status column stays aligned.
    const keptStatusCol = keptBody.indexOf("disabled");
    const orphanStatusCol = orphanBody.indexOf("disabled");
    assert.ok(keptStatusCol > 0 && orphanStatusCol > 0, "both show status");
    assert.strictEqual(
      keptStatusCol,
      orphanStatusCol,
      "status columns align despite the ⚠ badge",
    );
  });

  it("r remove still works on an orphaned assert", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["rules/defaults.json"], {
      "kept": { description: "K.", hook: "tool_call", shell: "true" },
    });

    const panel = makePanel([
      makeAssert("kept", "some/repo"),
      makeAssert("orphan", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    // Move down to the orphaned assert and press r.
    panel.nav.moveWithin("down");
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "orphan"?`)),
      "r opens the remove confirm for the orphaned assert",
    );
  });

  it("does NOT badge a local assert that shares a name with an orphaned repo assert", async () => {
    clearRepoEntriesCache();
    // Repo has "shared-name" but NOT "orphan-only".
    mockRepoFetch(["rules/defaults.json"], {
      "shared-name": { description: "S.", hook: "tool_call", shell: "true" },
    });

    // A local assert and a repo assert both named "shared-name"; plus a repo
    // assert "orphan-only" that IS orphaned.  The local "shared-name" must
    // never get ⚠, and the repo "shared-name" (exists upstream) must not
    // either — only "orphan-only" is badged.
    const panel = makePanel([
      makeAssert("shared-name", "local"),
      makeAssert("shared-name", "some/repo"),
      makeAssert("orphan-only", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);

    // The repo "orphan-only" assert IS orphaned → ⚠.
    const orphanLine = lines.find((l) => l.includes("orphan-only"));
    assert.ok(orphanLine?.includes("⚠"), "repo orphan gets ⚠");

    // Neither "shared-name" row (local nor repo) should be badged — the local
    // one is local (never orphaned), the repo one exists upstream.
    const sharedLines = lines.filter((l) => l.includes("shared-name"));
    assert.strictEqual(sharedLines.length, 2, "both shared-name rows rendered");
    for (const l of sharedLines) {
      assert.ok(!l.includes("⚠"), "shared-name row is not badged");
    }
  });

  it("does NOT badge a repo-A assert sharing a name with an orphaned repo-B assert", async () => {
    clearRepoEntriesCache();
    // repo-a has "dup"; repo-b does NOT (so repo-b's "dup" is orphaned).
    mock.method(globalThis, "fetch", (url: string) => {
      const isRepoA = url.includes("/repos/owner/repo-a");
      if (url.includes("/git/trees/")) {
        return mockJsonResponse({
          tree: [mockTreeBlob("rules/defaults.json")],
          truncated: false,
        });
      }
      const content = isRepoA
        ? { "dup": { description: "A.", hook: "tool_call", shell: "true" } }
        : { "other": { description: "B.", hook: "tool_call", shell: "true" } };
      return mockJsonResponse(mockFileItem("rules/defaults.json", content));
    });

    // "dup" exists in repo-a but NOT in repo-b → repo-b's "dup" is orphaned.
    // repo-a's "dup" must NOT be badged.
    const panel = makePanel([
      makeAssert("dup", "owner/repo-a"),
      makeAssert("dup", "owner/repo-b"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    const dupLines = lines.filter((l) => l.includes("dup"));
    assert.strictEqual(dupLines.length, 2, "both dup rows rendered");
    // Exactly one should be badged (repo-b's), the other not (repo-a's).
    // Without the composite source+name key, BOTH would be badged (both share
    // the name "dup", which is in the orphaned set via repo-b).
    const badged = dupLines.filter((l) => l.includes("⚠"));
    assert.strictEqual(badged.length, 1, "only one dup is orphaned");
  });

  it("shows a contextual 'removed from source repo' line under a focused orphaned assert", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["rules/defaults.json"], {
      "kept": { description: "K.", hook: "tool_call", shell: "true" },
    });

    const panel = makePanel([
      makeAssert("kept", "some/repo"),
      makeAssert("orphan", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    // Focus the orphaned assert (index 1 in the repo section).
    panel.nav.moveWithin("down");

    const lines = panel.render(80);
    const orphanIdx = lines.findIndex((l) => l.includes("orphan"));
    assert.ok(orphanIdx >= 0, "orphan row exists");

    // The line directly under the orphaned assert should be the contextual
    // warning — NOT just the shell/when detail.
    const detailLine = lines[orphanIdx + 1];
    assert.ok(
      detailLine?.includes("removed from source repo"),
      "contextual warning appears under the focused orphaned assert",
    );
    assert.ok(
      detailLine?.includes("press r to uninstall"),
      "warning tells the user how to act on it",
    );
  });

  it("does NOT show the 'removed from source repo' line under a non-orphaned assert", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["rules/defaults.json"], {
      "kept": { description: "K.", hook: "tool_call", shell: "true" },
    });

    const panel = makePanel([makeAssert("kept", "some/repo")]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    const keptIdx = lines.findIndex((l) => l.includes("kept"));
    assert.ok(keptIdx >= 0, "kept row exists");

    // The line under a non-orphaned assert should be the shell detail, NOT
    // the orphaned warning.
    const detailLine = lines[keptIdx + 1];
    assert.ok(
      detailLine?.includes("shell:"),
      "non-orphaned assert shows shell detail",
    );
    assert.ok(
      !lines.some((l) => l.includes("removed from source repo")),
      "no orphaned warning anywhere for a non-orphaned assert",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Fuzzy search mode (/ to search, Esc to exit)
// ═══════════════════════════════════════════════════════════════════

describe("AssertsPanel fuzzy search", () => {
  // The mock theme wraps accent text in [], so the query line renders as
  // "  [/query▏]" (accent) and a block cursor ▏.
  const queryLine = (lines: string[]) =>
    lines.find((l) => l.includes("▏") && l.includes("/"));

  it("`/` enters search mode and renders the query line", () => {
    const panel = makePanel([makeAssert("alpha"), makeAssert("beta")]);
    panel.handleInput("/", makeCtx());

    assert.ok(panel.isSearchActive, "search is active after /");
    const lines = panel.render(80);
    assert.ok(queryLine(lines), "renders the /query▏ line");
  });

  it("typing filters within sections and hides empty sections", () => {
    const panel = makePanel([
      makeAssert("write-guard"),
      makeAssert("no-env"),
      makeAssert("read-only", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());

    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("no-env")),
      "no-env matches 'env'");
    assert.ok(!lines.some((l) => l.includes("write-guard")),
      "write-guard is filtered out");
    assert.ok(!lines.some((l) => l.includes("repo/aaa")),
      "empty section (read-only didn't match) is hidden entirely");
  });

  it("Down moves within the filtered section and crosses to the next non-empty", () => {
    const panel = makePanel([
      makeAssert("alpha-env"),
      makeAssert("beta-env"),
      makeAssert("gamma-thing", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());
    // Local: alpha-env, beta-env; repo/aaa: gamma-thing also matches 'env'?
    // gamma-thing has no 'e','n','v' subsequence → excluded. So only local.

    // Start at alpha-env (row 0). Down → beta-env.
    panel.handleInput("\x1b[B", makeCtx()); // down
    assert.equal(panel.nav.focusedIndex, 1, "moved within the filtered local section");
  });

  it("Enter toggles the focused match", () => {
    const active = new Set<string>();
    const state = {
      asserts: [makeAssert("no-env"), makeAssert("write-guard")],
      active,
      enable(n: string) { active.add(n); },
      disable(n: string) { active.delete(n); },
      persist() {},
      updateStatus() {},
    } as unknown as AssertsState;
    const panel = new AssertsPanel(state);
    panel.setTheme(mockTheme());

    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());
    panel.handleInput("\r", makeCtx()); // Enter toggles no-env

    assert.ok(active.has("no-env"), "Enter toggles the focused match on");
  });

  it("Space appends to the query (and ignores it for matching in v1a)", () => {
    const panel = makePanel([makeAssert("no-env"), makeAssert("write-guard")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("o", makeCtx());
    panel.handleInput(" ", makeCtx());   // space → query char
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());

    // query is "no env" → strip → "noenv" which is a subsequence of "no-env".
    assert.ok(panel.isSearchActive, "still in search (Space didn't toggle)");
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("no-env")),
      "'no env' matches 'no-env' (spaces ignored for matching)");
    // query line should show the literal spaces.
    const q = queryLine(lines);
    assert.ok(q && q.includes("no env"), "query line displays the space");
  });

  it("Tab cycles between non-empty filtered sections", () => {
    const panel = makePanel([
      makeAssert("local-env"),
      makeAssert("repo-env", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    assert.equal(panel.nav.focusedSection, 0, "starts on local");
    panel.handleInput("\t", makeCtx());
    assert.equal(panel.nav.focusedSection, 1, "Tab cycles to repo/aaa");
  });

  it("Esc exits search WITHOUT closing the panel (returns undefined)", () => {
    const panel = makePanel([makeAssert("no-env"), makeAssert("write-guard")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    const result = panel.handleInput("\x1b", makeCtx()); // Esc
    assert.equal(result, undefined, "Esc during search does NOT cancel the panel");
    assert.ok(!panel.isSearchActive, "search mode is exited");
  });

  it("Esc restores focus to the highlighted match in the unfiltered view", () => {
    const panel = makePanel([
      makeAssert("alpha"),
      makeAssert("no-env"),
      makeAssert("write-guard", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());
    // Only "no-env" matches; it's the sole row in the filtered local section.
    assert.equal(panel.nav.focusedSection, 0);
    assert.equal(panel.nav.focusedIndex, 0);

    panel.handleInput("\x1b", makeCtx()); // Esc → exit
    assert.ok(!panel.isSearchActive);
    assert.equal(panel.nav.focusedSection, 0, "back on the local section");
    assert.equal(panel.nav.focusedIndex, 1, "focus restored to no-env's row in the unfiltered view");
  });

  it("empty results render 'No matches' (not 'No asserts defined!')", () => {
    const panel = makePanel([makeAssert("alpha"), makeAssert("beta")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("z", makeCtx());
    panel.handleInput("z", makeCtx());
    panel.handleInput("z", makeCtx());

    const lines = panel.render(80);
    assert.ok(lines.some((l) => l.includes("No matches")),
      "zero-match query shows 'No matches'");
    assert.ok(!lines.some((l) => l.includes("No asserts defined")),
      "never shows the empty-panel copy during search");
  });

  it("Backspace restores the list after widening back from no matches", () => {
    const panel = makePanel([makeAssert("alpha")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("z", makeCtx());
    assert.ok(panel.render(80).some((l) => l.includes("No matches")));
    panel.handleInput("\x7f", makeCtx()); // backspace → query ""
    const lines = panel.render(80);
    assert.ok(lines.some((l) => l.includes("alpha")),
      "back to empty query shows the list again");
  });

  it("focus is preserved when the focused assert still matches", () => {
    const panel = makePanel([makeAssert("write-guard"), makeAssert("no-env")]);
    panel.handleInput("/", makeCtx());
    // Move to no-env first.
    panel.handleInput("\x1b[B", makeCtx()); // down → no-env
    assert.equal(panel.nav.focusedItem?.name, "no-env");
    // Type 'e' — both still match (filtering may reorder within the section,
    // but focus must stay on no-env, not yank to write-guard).
    panel.handleInput("e", makeCtx());
    assert.equal(panel.nav.focusedItem?.name, "no-env",
      "focus stays on no-env, not reset to write-guard");
  });

  it("focus drops out to the same section's first match when the focused assert is filtered out", () => {
    const panel = makePanel([makeAssert("write-guard"), makeAssert("no-env")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("\x1b[B", makeCtx()); // down → no-env (index 1)
    assert.equal(panel.nav.focusedIndex, 1);
    // Type 'w' → only write-guard matches; no-env drops out.
    panel.handleInput("w", makeCtx());
    assert.equal(panel.nav.focusedSection, 0,
      "still in the local section (same source)");
    assert.equal(panel.nav.focusedIndex, 0,
      "focus fell back to the first remaining match, not section 0 index 1");
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("write-guard")));
    assert.ok(!lines.some((l) => l.includes("no-env")));
  });

  it("`/` is a no-op in confirm mode", () => {
    const panel = makePanel([makeAssert("alpha", "repo/owner")]);
    panel.handleInput("r", makeCtx()); // open remove confirm
    panel.handleInput("/", makeCtx());
    assert.ok(!panel.isSearchActive, "search not entered during confirm");
    assert.ok(panel.render(80).some((l) => l.includes(`Remove "alpha"?`)),
      "confirm dialog still open");
  });

  it("`/` is a no-op on an empty panel", () => {
    const panel = makePanel([]);
    panel.handleInput("/", makeCtx());
    assert.ok(!panel.isSearchActive, "no search on an empty panel");
  });

  it("normal mode: Space no longer toggles (no-op); Enter toggles", () => {
    const active = new Set<string>();
    const state = {
      asserts: [makeAssert("alpha")],
      active,
      enable(n: string) { active.add(n); },
      disable(n: string) { active.delete(n); },
      persist() {},
      updateStatus() {},
    } as unknown as AssertsState;
    const panel = new AssertsPanel(state);
    panel.setTheme(mockTheme());

    panel.handleInput(" ", makeCtx()); // Space — should NOT toggle
    assert.equal(active.size, 0, "Space does not toggle in normal mode");

    panel.handleInput("\r", makeCtx()); // Enter — toggles on
    assert.ok(active.has("alpha"), "Enter toggles in normal mode");
  });

  it("shows the search hint while search is active", () => {
    const panel = makePanel([makeAssert("alpha"), makeAssert("beta", "repo/aaa")]);
    panel.handleInput("/", makeCtx());
    const hint = panel.render(80).find((l) => l.includes("exit search"));
    assert.ok(hint, "search hint mentions 'exit search'");
    // r/t/d/i are suspended during search — their hints must not appear.
    const hintLines = panel.render(80).filter((l) => l.includes("exit search"));
    assert.ok(!hintLines.some((l) => /Remove|Install|Toggle default|Disable all/.test(l)),
      "r/t/d/i hints are omitted during search");
  });

  // ── Highlight rendering ─────────────────────────────────────────
  // The mock theme wraps accent text in `[]`, so a highlighted name splits
  // into per-char-run accent spans. These tests pin that the highlight is
  // actually emitted (not just that filtering happened).

  it("highlights matched chars in the focused row's name", () => {
    const panel = makePanel([makeAssert("no-env"), makeAssert("write-guard")]);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const lines = panel.render(80);
    // "no-env" is the sole match → focused (selected). The matched 'env'
    // run is its own accent span `[env]`, separate from the unmatched `no-`
    // prefix span — proving per-segment highlighting, not a whole-label wrap.
    const row = lines.find((l) => l.includes("no-env") || (l.includes("no-") && l.includes("env")));
    assert.ok(row, "no-env row renders");
    assert.ok(plain(row!).includes("no-env"), "name is intact after stripping accent");
    assert.ok(row!.includes("[env]"), "matched run is its own accent span");
  });

  it("highlights matched chars in the focused row's shell detail", () => {
    const panel = makePanel([
      makeAssert("alpha", "local", false, { shell: "run env-check" }),
    ]);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const lines = panel.render(80);
    const shellLine = lines.find((l) => l.includes("shell:"));
    assert.ok(shellLine, "shell detail renders");
    // Matched 'env' run is accent-highlighted (mock wraps accent in []);
    // unmatched chars are muted (mock returns them plain). 'run env-check'
    // has no 'e' before the 'env' token, so the greedy matcher hits it
    // contiguously.
    assert.ok(shellLine!.includes("[env]"),
      "matched chars in the shell command are highlighted");
  });

  // ── Highlight attribute: underline, not bold ────────────────────
  // Bold is too subtle to read against the accent-coloured selected row;
  // underline is hue-independent and fzf's default for current-line matches.
  // These tests use a tag-style theme so the attribute choice is observable.

  it("underlines (not bolds) matched chars on the focused row's name", () => {
    const theme = {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => `<b>${text}</b>`,
      underline: (text: string) => `<u>${text}</u>`,
    } as unknown as Theme;
    const state = {
      asserts: [makeAssert("no-env"), makeAssert("write-guard")],
      active: new Set<string>(),
    } as unknown as AssertsState;
    const panel = new AssertsPanel(state);
    panel.setTheme(theme);

    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const row = panel.render(80).find((l) => l.includes("no-") && l.includes("env"))!;
    assert.ok(row.includes("<u>env</u>"),
      "matched chars on the focused row are underlined");
    assert.ok(!row.includes("<b>"),
      "matched chars are not bolded (bold is unreadable against accent)");
  });

  it("underlines matched chars in the focused row's shell detail", () => {
    const theme = {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => `<b>${text}</b>`,
      underline: (text: string) => `<u>${text}</u>`,
    } as unknown as Theme;
    const state = {
      asserts: [makeAssert("alpha", "local", false, { shell: "run env-check" })],
      active: new Set<string>(),
    } as unknown as AssertsState;
    const panel = new AssertsPanel(state);
    panel.setTheme(theme);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const shellLine = panel.render(80).find((l) => l.includes("shell:"))!;
    assert.ok(shellLine.includes("<u>env</u>"),
      "matched chars in the shell detail are underlined on the focused row");
  });
});

// ── Presets ───────────────────────────────────────────────────────
//
// M1: a preset renders in its existing local/repo group with an `asserts:`
// detail (comma-joined refs) instead of `shell:`/`when:`.  The detail comes
// from `renderAssertDetail` dispatching on `preset` first, and the panel's
// `detailFor` branching on `isPreset`.

describe("AssertsPanel presets", () => {
  it("renders a preset row in the local group", () => {
    const panel = makePanel([
      makeAssert("guard"),
      makePreset("bundle", ["local/guard"]),
    ]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("bundle")),
      "the preset row is rendered",
    );
  });

  it("renders an asserts: detail (comma-joined refs) for a focused preset", () => {
    const panel = makePanel([
      makeAssert("guard"),
      makePreset("bundle", ["local/guard", "owner/repo/other"]),
    ]);
    // Focus the preset (second row in the local group).
    panel.nav.moveWithin("down");
    const lines = panel.render(80);
    const assertsLine = lines.find((l) => l.includes("asserts:"));
    assert.ok(assertsLine, "an asserts: detail line is shown for the preset");
    assert.ok(
      assertsLine!.includes("local/guard") && assertsLine!.includes("owner/repo/other"),
      "both refs appear comma-joined on the asserts: line",
    );
    // No shell:/when: detail for a preset.
    assert.ok(!lines.some((l) => l.includes("shell:")), "no shell: line for a preset");
    assert.ok(!lines.some((l) => l.includes("when:")), "no when: line for a preset");
  });

  it("renders an empty preset with an asserts: label and no refs", () => {
    const panel = makePanel([makePreset("empty", [])]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("asserts:")),
      "the asserts: label shows even for an empty preset",
    );
  });

  it("renders shell:/when: (not asserts:) for a focused shell assert", () => {
    const panel = makePanel([
      makeAssert("guard", "local", false, { shell: "false", when: "true" }),
    ]);
    const lines = panel.render(80);
    assert.ok(lines.some((l) => l.includes("shell:")), "shell: shown for a shell assert");
    assert.ok(lines.some((l) => l.includes("when:")), "when: shown when present");
    assert.ok(!lines.some((l) => l.includes("asserts:")), "no asserts: line for a shell assert");
  });

  it("toggles a preset's active state like a shell assert", () => {
    const active = new Set<string>();
    const state = {
      asserts: [makePreset("bundle", ["local/guard"])],
      active,
      enable(n: string) { active.add(n); },
      disable(n: string) { active.delete(n); },
      persist() {},
      updateStatus() {},
    } as unknown as AssertsState;
    const panel = new AssertsPanel(state);
    panel.setTheme(mockTheme());
    const ctx = makeCtx();
    // Enter toggles active on, regardless of assert kind.
    panel.handleInput("\r", ctx);
    assert.ok(active.has("bundle"), "preset is enabled after Enter");
    panel.handleInput("\r", ctx);
    assert.ok(!active.has("bundle"), "preset is disabled after a second Enter");
  });
});

// M1.5: preset coverage — a member of an active preset shows
// `active · via {preset}` instead of `disabled` when not individually active.
// The `via {preset}` run is accent; `active` is dim.  An individually active
// member shows just `enabled` (accent).  These tests use the mock theme where
// accent = `[...]`, so `via safety` renders as `[via safety]`.
describe("AssertsPanel preset coverage status", () => {
  it("shows 'active · via {preset}' for a member of an active preset (focused)", () => {
    const panel = makePanel(
      [makeAssert("guard"), makePreset("safety", ["local/guard"])],
      new Set(["safety"]),
    );
    const lines = panel.render(80);
    const guardLine = lines.find((l) => plain(l).includes("guard"));
    assert.ok(guardLine, "guard row is rendered");
    // `guard` is not individually active, but `safety` (active) references it.
    assert.ok(
      plain(guardLine!).includes("active") && guardLine!.includes("[via safety]"),
      "focused member shows 'active · via safety'",
    );
    assert.ok(
      !plain(guardLine!).includes("disabled"),
      "not 'disabled' when covered by an active preset",
    );
  });

  it("shows 'active · via {preset}' for a member in a non-focused section", () => {
    const panel = makePanel(
      [
        makeAssert("guard", "local"),
        makePreset("safety", ["local/guard"], "local"),
        makeAssert("other", "owner/repo"),
      ],
      new Set(["safety"]),
    );
    // Focus the repo section so the local section is non-focused (dimmed).
    panel.nav.cycleSection("next");
    const lines = panel.render(80);
    const guardLine = lines.find((l) => l.includes("guard"));
    assert.ok(guardLine, "guard row is rendered in the non-focused section");
    assert.ok(
      plain(guardLine!).includes("active") && guardLine!.includes("[via safety]"),
      "non-focused member also shows 'active · via safety'",
    );
  });

  it("shows 'enabled' (not 'via') when a member is active individually too", () => {
    const panel = makePanel(
      [makeAssert("guard"), makePreset("safety", ["local/guard"])],
      new Set(["guard", "safety"]),
    );
    const lines = panel.render(80);
    const guardLine = lines.find((l) => plain(l).includes("guard"));
    assert.ok(guardLine, "guard row is rendered");
    assert.ok(
      plain(guardLine!).includes("enabled"),
      "individually active member shows 'enabled'",
    );
    assert.ok(
      !guardLine!.includes("via"),
      "no 'via' suffix when already active individually",
    );
  });

  it("shows 'disabled' when the covering preset is inactive", () => {
    const panel = makePanel(
      [makeAssert("guard"), makePreset("safety", ["local/guard"])],
      new Set(), // nothing active
    );
    const lines = panel.render(80);
    const guardLine = lines.find((l) => plain(l).includes("guard"));
    assert.ok(guardLine, "guard row is rendered");
    assert.ok(
      plain(guardLine!).includes("disabled"),
      "member shows 'disabled' when the preset is inactive",
    );
    assert.ok(
      !guardLine!.includes("via"),
      "no 'via' suffix when the preset is inactive",
    );
  });

  it("collapses multiple covering presets to 'via {n} presets'", () => {
    const panel = makePanel(
      [
        makeAssert("guard"),
        makePreset("p1", ["local/guard"]),
        makePreset("p2", ["local/guard"]),
      ],
      new Set(["p1", "p2"]),
    );
    const lines = panel.render(80);
    const guardLine = lines.find((l) => plain(l).includes("guard"));
    assert.ok(guardLine, "guard row is rendered");
    assert.ok(
      guardLine!.includes("[via 2 presets]"),
      "multiple covering presets collapse to 'via 2 presets'",
    );
  });

  it("updates coverage status after toggling the preset off", () => {
    const active = new Set<string>(["safety"]);
    const state = {
      asserts: [makeAssert("guard"), makePreset("safety", ["local/guard"])],
      active,
      enable(n: string) { active.add(n); },
      disable(n: string) { active.delete(n); },
      persist() {},
      updateStatus() {},
    } as unknown as AssertsState;
    const panel = new AssertsPanel(state);
    panel.setTheme(mockTheme());
    const ctx = makeCtx();

    // Initially: guard shows 'active · via safety'.
    let lines = panel.render(80);
    let guardLine = lines.find((l) => plain(l).includes("guard"));
    assert.ok(guardLine!.includes("[via safety]"), "initially covered by safety");

    // Focus the preset (2nd row) and toggle it off.
    panel.nav.moveWithin("down");
    panel.handleInput("\r", ctx);
    assert.ok(!active.has("safety"), "safety toggled off");

    // After toggle: guard shows 'disabled' (no active preset covers it).
    panel.nav.moveWithin("up"); // focus back to guard
    lines = panel.render(80);
    guardLine = lines.find((l) => plain(l).includes("guard"));
    assert.ok(
      plain(guardLine!).includes("disabled"),
      "guard reverts to 'disabled' after the covering preset is toggled off",
    );
    assert.ok(!guardLine!.includes("via"), "no 'via' after toggle-off");
  });
});

