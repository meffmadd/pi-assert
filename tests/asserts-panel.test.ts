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
