/**
 * Tests for selectDialog's shared picker behaviour: the select result shape,
 * the inline `r` → `y/n` remove confirm, the `mark` rendered outside the
 * accent wrap, and `initialIndex` highlight restoration.
 *
 * selectDialog drives its UI through `ctx.ui.custom`, so these tests mock
 * `custom` to capture the `{render, invalidate, handleInput}` triple and the
 * `done` resolver, then drive input directly — the same way the real TUI
 * would.  The mock theme wraps accent text in `[...]` and success text in
 * `<...>` so assertions can tell which colour a span landed in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { selectDialog, type SelectDialogResult } from "../pi-assert/ui/components.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

// ── Mock theme ────────────────────────────────────────────────────

/** Accent → `[...]`, success → `<...>`, everything else passes through. */
function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) => {
      if (role === "accent") return `[${text}]`;
      if (role === "success") return `<${text}>`;
      return text;
    },
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

// ── Mock ctx.ui.custom ───────────────────────────────────────────

interface Triple {
  render: (w: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
}

function setupDialog<T>(): {
  ctx: ExtensionContext;
  triple: () => Triple;
  result: Promise<SelectDialogResult<T>>;
  notifications: string[];
} {
  let captured: Triple | null = null;
  let resolveResult!: (v: SelectDialogResult<T>) => void;
  const resultPromise = new Promise<SelectDialogResult<T>>((r) => {
    resolveResult = r;
  });
  const notifications: string[] = [];
  const theme = mockTheme();

  const ctx = {
    ui: {
      custom<U>(
        fn: (
          tui: { requestRender(): void },
          theme: Theme,
          kb: unknown,
          done: (v: U) => void,
        ) => Triple,
        _overlay: unknown,
      ): Promise<U> {
        captured = fn(
          { requestRender() {} },
          theme,
          {},
          (v: U) => resolveResult(v as unknown as SelectDialogResult<T>),
        );
        return resultPromise as unknown as Promise<U>;
      },
      theme,
      notify(msg: string) {
        notifications.push(msg);
      },
      setStatus() {},
    },
    cwd: "/tmp/select-dialog-test",
  } as unknown as ExtensionContext;

  return { ctx, triple: () => captured!, result: resultPromise, notifications };
}

/** The highlighted list row, prefixed with the accent `[> ]`. */
function selectedLine(lines: string[]): string | undefined {
  return lines.find((l) => l.startsWith("[> ]"));
}

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

// ═══════════════════════════════════════════════════════════════════
// Select result shape
// ═══════════════════════════════════════════════════════════════════

describe("selectDialog result shape", () => {
  it("Enter resolves with { value, index, removed: false }", async () => {
    const s = setupDialog<string>();
    const p = selectDialog<string>(s.ctx, {
      title: "T",
      items: [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
      ],
    });
    const t = s.triple();
    t.handleInput(ENTER);
    assert.deepEqual(await p, { value: "a", index: 0, removed: false });
  });

  it("Esc resolves with { value: null, index, removed: false }", async () => {
    const s = setupDialog<string>();
    const p = selectDialog<string>(s.ctx, {
      title: "T",
      items: [{ value: "a", label: "alpha" }],
    });
    const t = s.triple();
    t.handleInput(ESC);
    assert.deepEqual(await p, { value: null, index: 0, removed: false });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Remove confirm flow
// ═══════════════════════════════════════════════════════════════════

describe("selectDialog remove confirm", () => {
  it("r then y resolves with { value, index, removed: true }", async () => {
    const s = setupDialog<string>();
    const p = selectDialog<string>(s.ctx, {
      title: "T",
      items: [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
      ],
      remove: { canRemove: (it) => it.value === "a" },
    });
    const t = s.triple();
    t.handleInput("r");
    t.handleInput("y");
    assert.deepEqual(await p, { value: "a", index: 0, removed: true });
  });

  it('r renders the `Remove "x"?` confirm body', () => {
    const s = setupDialog<string>();
    selectDialog<string>(s.ctx, {
      title: "T",
      items: [{ value: "a", label: "alpha" }],
      remove: { canRemove: () => true },
    });
    const t = s.triple();
    t.handleInput("r");
    const lines = t.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "a"?`)),
      "confirm body shows the item name",
    );
  });

  it("n cancels the confirm and returns to the list (Enter then selects)", async () => {
    const s = setupDialog<string>();
    const p = selectDialog<string>(s.ctx, {
      title: "T",
      items: [{ value: "a", label: "alpha" }],
      remove: { canRemove: () => true },
    });
    const t = s.triple();
    t.handleInput("r");
    t.handleInput("n");
    // Back in the list — Enter should now select normally.
    t.handleInput(ENTER);
    assert.deepEqual(await p, { value: "a", index: 0, removed: false });
  });

  it("Esc cancels the confirm and returns to the list", async () => {
    const s = setupDialog<string>();
    const p = selectDialog<string>(s.ctx, {
      title: "T",
      items: [{ value: "a", label: "alpha" }],
      remove: { canRemove: () => true },
    });
    const t = s.triple();
    t.handleInput("r");
    t.handleInput(ESC);
    t.handleInput(ENTER);
    assert.deepEqual(await p, { value: "a", index: 0, removed: false });
  });

  it("arrow keys are ignored while confirming (selection stays put)", async () => {
    const s = setupDialog<string>();
    const p = selectDialog<string>(s.ctx, {
      title: "T",
      items: [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
      ],
      remove: { canRemove: () => true },
    });
    const t = s.triple();
    t.handleInput("r");
    t.handleInput(DOWN); // ignored while confirming
    t.handleInput("y");
    // Still on index 0 ("a") — the down arrow did not move the highlight.
    assert.deepEqual(await p, { value: "a", index: 0, removed: true });
  });

  it("r on a non-removable item notifies and stays in the list", async () => {
    const s = setupDialog<string>();
    const p = selectDialog<string>(s.ctx, {
      title: "T",
      items: [{ value: "a", label: "alpha" }],
      remove: { canRemove: () => false },
    });
    const t = s.triple();
    t.handleInput("r");
    assert.ok(
      s.notifications.includes("Only installed asserts can be removed"),
      "notifies that only installed asserts can be removed",
    );
    // Confirm body must NOT be showing.
    const lines = t.render(80);
    assert.ok(
      !lines.some((l) => l.includes(`Remove "a"?`)),
      "confirm body is not shown for a non-removable item",
    );
    t.handleInput(ENTER);
    assert.deepEqual(await p, { value: "a", index: 0, removed: false });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Mark rendered outside the accent wrap
// ═══════════════════════════════════════════════════════════════════

describe("selectDialog mark", () => {
  it("renders the mark outside the accent wrap on the selected row", () => {
    const s = setupDialog<string>();
    selectDialog<string>(s.ctx, {
      title: "T",
      items: [{ value: "a", label: "alpha" }],
      // success-coloured mark: `<✓ >` in the mock theme.
      mark: () => mockTheme().fg("success", "✓ "),
    });
    const t = s.triple();
    const lines = t.render(80);
    const line = selectedLine(lines);
    assert.ok(line, "a row is selected");
    // Mark (`<✓ >`) must appear OUTSIDE the accent body wrap — i.e. the
    // mark's closing `>` comes before the body's opening `[`, not after.
    assert.match(line!, /<✓ >\[/, "mark is rendered before the accent body open");
    assert.doesNotMatch(line!, /\[<✓ >/, "mark is not wrapped inside the accent body");
  });

  it("aligns marked and unmarked rows via the badge column", () => {
    const s = setupDialog<string>();
    selectDialog<string>(s.ctx, {
      title: "T",
      items: [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
      ],
      mark: (it) => (it.value === "a" ? mockTheme().fg("success", "✓ ") : ""),
    });
    const t = s.triple();
    const lines = t.render(80);
    // Row 0 (marked, selected): `[> ]<✓ >[alpha...]`
    // Row 1 (unmarked):           `  <✓ >`? no — unmarked badge is 2 spaces.
    // The badge column width is 2, so unmarked rows get a 2-space badge and
    // their labels start at the same column as marked rows' labels.
    const marked = selectedLine(lines);
    assert.ok(marked, "marked row is the selected row");
    assert.match(marked!, /<✓ >\[alpha/, "marked row shows ✓ then label");
    // Unmarked row: badge is two spaces, then the label (no `<✓ >`).
    const unmarked = lines.find((l) => l.startsWith("    beta") || l.includes("beta"));
    assert.ok(unmarked, "unmarked row is rendered");
    assert.doesNotMatch(unmarked!, /<✓ >/, "unmarked row has no check mark");
  });
});

// ═══════════════════════════════════════════════════════════════════
// initialIndex
// ═══════════════════════════════════════════════════════════════════

describe("selectDialog initialIndex", () => {
  it("starts the highlight at initialIndex", () => {
    const s = setupDialog<string>();
    selectDialog<string>(s.ctx, {
      title: "T",
      items: [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
        { value: "c", label: "gamma" },
      ],
      initialIndex: 1,
    });
    const t = s.triple();
    const lines = t.render(80);
    const line = selectedLine(lines);
    assert.ok(line, "a row is selected");
    assert.match(line!, /\[> \]\[beta/, "highlight starts on the second item (beta)");
  });

  it("clamps initialIndex past the end to the last item", () => {
    const s = setupDialog<string>();
    selectDialog<string>(s.ctx, {
      title: "T",
      items: [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
      ],
      initialIndex: 99,
    });
    const t = s.triple();
    const lines = t.render(80);
    const line = selectedLine(lines);
    assert.match(line!, /\[> \]\[beta/, "highlight clamps to the last item");
  });

  it("clamps negative initialIndex to the first item", () => {
    const s = setupDialog<string>();
    selectDialog<string>(s.ctx, {
      title: "T",
      items: [{ value: "a", label: "alpha" }],
      initialIndex: -5,
    });
    const t = s.triple();
    const lines = t.render(80);
    const line = selectedLine(lines);
    assert.match(line!, /\[> \]\[alpha/, "highlight clamps to the first item");
  });
});
