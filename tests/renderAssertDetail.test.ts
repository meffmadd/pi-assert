/**
 * Tests for the shared renderAssertDetail helper used by both the
 * /asserts panel and the install wizard's assert-entry picker.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderAssertDetail, renderDetailList, DetailList } from "../pi-assert/ui/components.js";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) =>
      role === "accent" ? `[${text}]` : text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

describe("renderAssertDetail — preset branch", () => {
  it("renders the asserts: label with comma-joined refs", () => {
    const lines = renderAssertDetail(mockTheme(), 80, {
      preset: ["local/foo", "owner/repo/bar"],
    });
    assert.ok(
      lines.some((l) => l.includes("asserts:") && l.includes("local/foo") && l.includes("owner/repo/bar")),
      "shows the asserts: label with both refs",
    );
  });

  it("dispatches on preset first — no shell:/when: lines for a preset", () => {
    const lines = renderAssertDetail(mockTheme(), 80, {
      preset: ["local/foo"],
    });
    assert.ok(!lines.some((l) => l.includes("shell:")), "no shell: line");
    assert.ok(!lines.some((l) => l.includes("when:")), "no when: line");
  });

  it("renders an empty preset array as asserts: (with nothing after)", () => {
    const lines = renderAssertDetail(mockTheme(), 80, { preset: [] });
    assert.ok(
      lines.some((l) => l.includes("asserts:")),
      "shows the asserts: label even for an empty preset",
    );
  });

  it("wraps a long ref list across continuation lines", () => {
    const refs = Array.from({ length: 8 }, (_, i) => `local/ref-${i}`);
    const lines = renderAssertDetail(mockTheme(), 40, { preset: refs });
    assert.ok(
      lines.some((l) => l.includes("asserts:") && l.includes("ref-0")),
      "first line shows the asserts: label and the first ref",
    );
    assert.ok(
      lines.some((l) => !l.includes("asserts:") && l.includes("ref-7")),
      "wrapped continuation line appears",
    );
  });
});

describe("renderAssertDetail", () => {
  it("renders the shell label and command", () => {
    const lines = renderAssertDetail(mockTheme(), 80, { shell: "echo hello" });
    assert.ok(
      lines.some((l) => l.includes("shell:") && l.includes("echo hello")),
      "shows the shell label and command",
    );
  });

  it("renders the when precondition when present", () => {
    const lines = renderAssertDetail(mockTheme(), 80, {
      shell: "echo hello",
      when: "test -f ./flag",
    });
    assert.ok(
      lines.some((l) => l.includes("when:") && l.includes("test -f ./flag")),
      "shows the when precondition",
    );
  });

  it("omits the when line when absent", () => {
    const lines = renderAssertDetail(mockTheme(), 80, { shell: "echo hello" });
    assert.ok(
      !lines.some((l) => l.includes("when:")),
      "does not show a when line when absent",
    );
  });

  it("places the shell block before the when block", () => {
    const lines = renderAssertDetail(mockTheme(), 80, {
      shell: "echo shell-cmd",
      when: "echo when-cmd",
    });
    const shellIdx = lines.findIndex((l) => l.includes("shell-cmd"));
    const whenIdx = lines.findIndex((l) => l.includes("when-cmd"));
    assert.ok(shellIdx >= 0 && whenIdx > shellIdx, "shell precedes when");
  });

  it("wraps long shell commands onto continuation lines", () => {
    const longShell =
      "echo one two three four five six seven eight nine ten eleven twelve";
    const lines = renderAssertDetail(mockTheme(), 40, { shell: longShell });
    assert.ok(
      lines.some((l) => l.includes("shell:") && l.includes("echo")),
      "first detail line shows the shell label",
    );
    assert.ok(
      lines.some((l) => !l.includes("shell:") && l.includes("twelve")),
      "wrapped continuation line appears",
    );
  });

  it("indents continuation lines under the label", () => {
    const lines = renderAssertDetail(mockTheme(), 40, {
      shell: "echo one two three four five six seven eight nine ten",
    });
    const cont = lines.find((l) => !l.includes("shell:") && l.includes("ten"));
    assert.ok(cont, "continuation line exists");
    // Continuation aligns under the shell value: indent (4) + "shell: " (7).
    assert.match(cont!, /^ {11}\S/, "continuation aligns under the shell value");
  });
});

// ── Shared list core + component ───────────────────────────────────
//
// renderDetailList is the pure core used by BOTH the /asserts panel's active
// section and the install wizard's DetailList.  These tests cover the shared
// behaviour (prefix, inline detail under the highlighted row, windowing,
// scroll indicator) so it only has to be asserted once.

describe("renderDetailList", () => {
  const theme = mockTheme();

  interface Item { name: string; shell: string; when?: string; }

  function render(items: Item[], selectedIndex: number, opts: { window?: [number, number]; maxVisible?: number; showScrollIndicator?: boolean } = {}): string[] {
    return renderDetailList(theme, 80, {
      items,
      selectedIndex,
      window: opts.window,
      maxVisible: opts.maxVisible,
      showScrollIndicator: opts.showScrollIndicator,
      renderRow: (item, selected) =>
        selected ? theme.fg("accent", item.name) : item.name,
      detailFor: (item) => ({ shell: item.shell, when: item.when }),
    });
  }

  const items: Item[] = [
    { name: "alpha", shell: "echo alpha-cmd", when: "test -f a" },
    { name: "beta", shell: "echo beta-cmd" },
    { name: "gamma", shell: "echo gamma-cmd" },
  ];

  it("renders the detail block directly under the highlighted row", () => {
    const lines = render(items, 0);
    const rowIdx = lines.findIndex((l) => l.includes("alpha") && !l.includes("shell:"));
    const shellIdx = lines.findIndex((l) => l.includes("alpha-cmd"));
    assert.ok(rowIdx >= 0, "alpha row exists");
    assert.ok(shellIdx >= 0, "alpha shell line exists");
    assert.equal(shellIdx, rowIdx + 1, "shell line sits directly under the highlighted row");
  });

  it("uses the '> ' prefix only for the highlighted row", () => {
    const lines = render(items, 0);
    const highlighted = lines.find((l) => l.includes("> "));
    assert.ok(highlighted, "a highlighted row with '> ' exists");
    // Only one row carries the prefix.
    assert.equal(lines.filter((l) => l.includes("> ")).length, 1);
  });

  it("renders the when line under shell when present", () => {
    const lines = render(items, 0);
    assert.ok(lines.some((l) => l.includes("when:") && l.includes("test -f a")));
  });

  it("omits the when line for entries without when", () => {
    const lines = render(items, 1);
    assert.ok(lines.some((l) => l.includes("beta-cmd")));
    assert.ok(!lines.some((l) => l.includes("when:")));
  });

  it("does not render detail for non-highlighted rows", () => {
    const lines = render(items, 0);
    assert.ok(lines.some((l) => l.includes("alpha-cmd")));
    assert.ok(!lines.some((l) => l.includes("beta-cmd")));
    assert.ok(!lines.some((l) => l.includes("gamma-cmd")));
  });

  it("moves the detail block when the selection moves", () => {
    const lines = render(items, 1);
    assert.ok(lines.some((l) => l.includes("beta-cmd")));
    assert.ok(!lines.some((l) => l.includes("alpha-cmd")));
  });

  it("respects an external [start,end) window", () => {
    const lines = render(items, 1, { window: [1, 2] });
    // Only beta (index 1) is in the window, and it is highlighted.
    assert.ok(lines.some((l) => l.includes("beta-cmd")));
    assert.ok(!lines.some((l) => l.includes("alpha-cmd")));
    assert.ok(!lines.some((l) => l.includes("gamma-cmd")));
  });

  it("shows a scroll indicator only when windowed and requested", () => {
    // No indicator when everything fits.
    assert.ok(!render(items, 0, { maxVisible: 10, showScrollIndicator: true }).some((l) => l.includes("/3)")));
    // Indicator appears when the list is windowed.
    const big: Item[] = Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, shell: "true" }));
    const lines = render(big, 0, { maxVisible: 5, showScrollIndicator: true });
    assert.ok(lines.some((l) => l.includes("/12)")), "scroll indicator shown when windowed");
  });

  it("returns [] for empty items", () => {
    assert.deepEqual(render([], 0), []);
  });
});

describe("DetailList (stateful component)", () => {
  const theme = mockTheme();

  function makeItems(): SelectItem[] {
    return [
      { value: "alpha", label: "alpha", description: "Alpha rule." },
      { value: "beta", label: "beta", description: "Beta rule." },
      { value: "gamma", label: "gamma", description: "Gamma rule." },
    ];
  }

  function makeList(items: SelectItem[]): DetailList<SelectItem> {
    const detailFor = (item: SelectItem) => {
      if (item.value === "alpha") return { shell: "echo alpha-cmd", when: "test -f a" };
      if (item.value === "beta") return { shell: "echo beta-cmd" };
      if (item.value === "gamma") return { shell: "echo gamma-cmd" };
      return undefined;
    };
    const renderRow = (item: SelectItem, selected: boolean) => {
      const body = `${item.label}  ${item.description ?? ""}`;
      return selected ? theme.fg("accent", body) : body;
    };
    return new DetailList(items, 10, theme, renderRow, detailFor);
  }

  it("renders the detail block directly under the highlighted row", () => {
    const list = makeList(makeItems());
    const lines = list.render(80);

    const alphaIdx = lines.findIndex((l) => l.includes("alpha-cmd"));
    const rowIdx = lines.findIndex((l) => l.includes("Alpha rule."));
    assert.ok(rowIdx >= 0, "alpha row exists");
    assert.ok(alphaIdx >= 0, "alpha shell line exists");
    assert.equal(alphaIdx, rowIdx + 1, "shell line sits directly under the highlighted row");
  });

  it("renders the when line under shell for the highlighted row", () => {
    const list = makeList(makeItems());
    const lines = list.render(80);
    assert.ok(
      lines.some((l) => l.includes("when:") && l.includes("test -f a")),
      "shows the when precondition inline",
    );
  });

  it("does not render detail for non-highlighted rows", () => {
    const list = makeList(makeItems());
    const lines = list.render(80);
    assert.ok(lines.some((l) => l.includes("alpha-cmd")));
    assert.ok(!lines.some((l) => l.includes("beta-cmd")));
    assert.ok(!lines.some((l) => l.includes("gamma-cmd")));
  });

  it("moves the detail block when the selection moves down", () => {
    const list = makeList(makeItems());
    list.selectedIndex = 1; // move to beta
    const lines = list.render(80);
    assert.ok(lines.some((l) => l.includes("beta-cmd")), "beta detail now shown");
    assert.ok(!lines.some((l) => l.includes("alpha-cmd")), "alpha detail removed");
  });

  it("omits the when line for entries without when", () => {
    const list = makeList(makeItems());
    list.selectedIndex = 1; // beta has no when
    const lines = list.render(80);
    assert.ok(lines.some((l) => l.includes("beta-cmd")));
    assert.ok(!lines.some((l) => l.includes("when:")), "no when line for beta");
  });

  it("fires onSelect on enter and onCancel on escape", () => {
    const list = makeList(makeItems());
    let selected: SelectItem | undefined;
    let cancelled = false;
    list.onSelect = (item) => { selected = item; };
    list.onCancel = () => { cancelled = true; };

    list.handleInput("\r"); // enter
    assert.ok(selected, "onSelect fired on enter");
    assert.equal(selected!.value, "alpha");

    list.handleInput("\u001b"); // escape
    assert.ok(cancelled, "onCancel fired on escape");
  });

  it("with detailFor returning undefined renders no detail and uses '> ' prefix (repo/rule-file pickers)", () => {
    const items: SelectItem[] = [
      { value: "r1", label: "owner/repo-a" },
      { value: "r2", label: "owner/repo-b" },
    ];
    const list = new DetailList(
      items,
      10,
      theme,
      (item, selected) => (selected ? theme.fg("accent", item.label) : item.label),
      () => undefined, // no detail — matches the plain repo/rule-file pickers
    );
    const lines = list.render(80);

    // Shared highlight prefix, exactly one highlighted row.
    assert.ok(lines.some((l) => l.includes("> ")), "uses '> ' prefix");
    assert.equal(lines.filter((l) => l.includes("> ")).length, 1);

    // No shell/when detail anywhere — this is the plain-picker case.
    assert.ok(!lines.some((l) => l.includes("shell:")));
    assert.ok(!lines.some((l) => l.includes("when:")));

    // Both rows present.
    assert.ok(lines.some((l) => l.includes("owner/repo-a")));
    assert.ok(lines.some((l) => l.includes("owner/repo-b")));
  });
});
