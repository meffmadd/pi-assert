import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Component,
  Container,
  matchesKey,
  Key,
  Text,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences so we can measure visible text width. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Wrap plain text at word boundaries (or hard boundaries when a single
 * word exceeds the allowed width).  Preserves existing line breaks.
 * Returns one entry per visual line.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    while (line.length > width) {
      let breakAt = width;
      const spaceIndex = line.lastIndexOf(" ", width);
      if (spaceIndex > 0) {
        breakAt = spaceIndex;
      }
      lines.push(line.slice(0, breakAt));
      line = line.slice(breakAt).trimStart();
    }
    if (line.length > 0 || lines.length === 0) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * Render the `shell:` / `when:` detail block used by both the /asserts
 * panel and the install wizard's assert-entry picker.  `when` is only
 * shown when present, matching the standard assert view.
 */
export function renderAssertDetail(
  theme: Theme,
  width: number,
  entry: { shell: string; when?: string },
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const muted = (s: string) => theme.fg("muted", s);

  const indent = 4;
  const shellLabel = "shell: ";
  const whenLabel = "when: ";

  const lines: string[] = [];

  const shellWidth = Math.max(1, width - indent - shellLabel.length);
  const shellLines = wrapText(entry.shell, shellWidth);
  for (let i = 0; i < shellLines.length; i++) {
    if (i === 0) {
      lines.push(" ".repeat(indent) + dim(shellLabel) + muted(shellLines[i]!));
    } else {
      lines.push(
        " ".repeat(indent + shellLabel.length) + muted(shellLines[i]!),
      );
    }
  }

  if (entry.when) {
    const whenWidth = Math.max(1, width - indent - whenLabel.length);
    const whenLines = wrapText(entry.when, whenWidth);
    for (let i = 0; i < whenLines.length; i++) {
      if (i === 0) {
        lines.push(" ".repeat(indent) + dim(whenLabel) + muted(whenLines[i]!));
      } else {
        lines.push(
          " ".repeat(indent + whenLabel.length) + muted(whenLines[i]!),
        );
      }
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Shared overlay width for all install-flow dialogs so every window stays
// the same size. Fixed character width, with a matching floor so narrow
// terminals still get a usable minimum.
// ---------------------------------------------------------------------------
export const DIALOG_WIDTH = 80;
export const DIALOG_MIN_WIDTH = 80;

// ---------------------------------------------------------------------------
// borderBox — wrap arbitrary content in DynamicBorder / Text / Container
// pieces.  The build functions return Container ready to be returned from
// ctx.ui.custom's render.
// ---------------------------------------------------------------------------
function titledBox(theme: Theme, title: string, children: Component[]): Container {
  const container = new Container();
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
  for (const c of children) container.addChild(c);
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  return container;
}

// ---------------------------------------------------------------------------
// selectDialog — the single install-flow picker.  Every install view (repo
// picker, rule-file picker, assert-entry picker) goes through here so they
// all share the same navigation, "> " highlight prefix, windowing, scroll
// indicator, and label+description column layout — backed by DetailList.
//
// Pass `detailFor` to render the inline `shell:` / `when:` preview directly
// under the highlighted row (the assert-entry picker does this).  Omit it
// for plain pickers (repo / rule-file) which just get the shared list look
// with no detail block.
// ---------------------------------------------------------------------------
export async function selectDialog<T>(
  ctx: ExtensionContext,
  opts: {
    title: string;
    items: SelectItem[];
    hint?: string;
    maxVisible?: number;
    /** Resolve the shell/when preview for a given item value. */
    detailFor?: (value: string) => { shell: string; when?: string } | undefined;
  },
): Promise<T | null> {
  const hasDetail = !!opts.detailFor;

  return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
    const max = opts.maxVisible ?? Math.min(opts.items.length, hasDetail ? 10 : 12);

    // Label column: widest label + 2-char gap, clamped to a sane range.
    const primary = Math.min(
      Math.max(
        opts.items.reduce((w, it) => Math.max(w, visibleWidth(it.label)), 0) + 2,
        8,
      ),
      40,
    );

    const renderRow = (item: SelectItem, selected: boolean, w: number): string => {
      const label = truncateToWidth(item.label, primary - 2, "");
      const labelPad = " ".repeat(Math.max(1, primary - visibleWidth(label)));
      const descStart = 2 + primary; // prefix(2) + primary column
      const descRemaining = Math.max(0, w - descStart - 2);
      if (item.description && descRemaining > 10) {
        const desc = truncateToWidth(item.description, descRemaining, "");
        const body = `${label}${labelPad}${desc}`;
        return selected
          ? theme.fg("accent", body)
          : `${label}${theme.fg("muted", labelPad + desc)}`;
      }
      return selected ? theme.fg("accent", label) : label;
    };

    const list = new DetailList<SelectItem>(
      opts.items,
      max,
      theme,
      renderRow,
      (item) => opts.detailFor?.(item.value),
    );
    list.onSelect = (item) => done(item.value as T);
    list.onCancel = () => done(null);

    const container = titledBox(theme, opts.title, [
      list,
      new Text(theme.fg("dim", opts.hint ?? "↑↓ navigate • enter select • esc cancel"), 1, 0),
    ]);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: DIALOG_WIDTH,
      minWidth: DIALOG_MIN_WIDTH,
      // Reserve room for the multi-line detail block when present.
      maxHeight: Math.min(opts.items.length + (hasDetail ? 12 : 4), hasDetail ? 24 : 16),
      margin: 4,
    },
  });
}

// ---------------------------------------------------------------------------
// renderDetailList — the shared core used by BOTH the /asserts panel's
// active section and the install wizard's assert-entry picker.  It renders a
// windowed slice of items, highlights the selected row with a "> " prefix,
// and inserts the `shell:` / `when:` detail block (via renderAssertDetail)
// *directly under the highlighted row* — the layout both views share.
//
// Callers customise the row body via `renderRow` and the preview via
// `detailFor`, so the list scaffolding (prefix, windowing, inline detail,
// optional scroll indicator) lives in exactly one place.
// ---------------------------------------------------------------------------
export interface DetailListOptions<T> {
  items: T[];
  selectedIndex: number;
  /**
   * External `[start, end)` window.  When omitted, an internal window of
   * `maxVisible` items centered on the selection is computed.  The /asserts
   * panel passes its own window (it manages per-section scrolling); the
   * install dialog lets the list window itself.
   */
  window?: [number, number];
  maxVisible?: number;
  /** Render a dim `(n/total)` indicator when the list is windowed. */
  showScrollIndicator?: boolean;
  /** Render the body of one row — everything after the `"> "` / `"  "` prefix. */
  renderRow: (item: T, selected: boolean, width: number) => string;
  /** Resolve the shell/when preview for an item. `undefined` skips the detail. */
  detailFor: (item: T) => { shell: string; when?: string } | undefined;
}

export function renderDetailList<T>(
  theme: Theme,
  width: number,
  opts: DetailListOptions<T>,
): string[] {
  const { items, selectedIndex, renderRow, detailFor } = opts;
  const len = items.length;
  if (len === 0) return [];

  let start: number;
  let end: number;
  if (opts.window) {
    [start, end] = opts.window;
  } else {
    const maxVisible = opts.maxVisible ?? Math.min(len, 10);
    const half = Math.floor(maxVisible / 2);
    start = Math.max(0, Math.min(selectedIndex - half, len - maxVisible));
    end = Math.min(start + maxVisible, len);
    if (end - start < maxVisible) start = Math.max(0, end - maxVisible);
  }

  const lines: string[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i];
    if (!item) continue;
    const selected = i === selectedIndex;
    const prefix = selected ? theme.fg("accent", "> ") : "  ";
    lines.push(prefix + renderRow(item, selected, width));

    // Detail block directly under the highlighted row.
    if (selected) {
      const entry = detailFor(item);
      if (entry) lines.push(...renderAssertDetail(theme, width, entry));
    }
  }

  if (opts.showScrollIndicator && (start > 0 || end < len)) {
    lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${len})`));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// DetailList — stateful single-select component wrapping renderDetailList,
// with up/down/enter/escape input handling.  Used by the install wizard's
// assert-entry picker (selectDialogWithDetail).  The /asserts panel calls
// renderDetailList directly instead, because it drives selection/windowing
// externally across multiple sections.
// ---------------------------------------------------------------------------
export class DetailList<T = SelectItem> implements Component {
  selectedIndex = 0;
  onSelect?: (item: T) => void;
  onCancel?: () => void;

  constructor(
    private items: T[],
    private maxVisible: number,
    private theme: Theme,
    private renderRow: (item: T, selected: boolean, width: number) => string,
    private detailFor: (item: T) => { shell: string; when?: string } | undefined,
  ) {}

  invalidate() {}

  render(width: number): string[] {
    if (this.items.length === 0) {
      return [this.theme.fg("warning", "  No matching commands")];
    }
    return renderDetailList(this.theme, width, {
      items: this.items,
      selectedIndex: this.selectedIndex,
      maxVisible: this.maxVisible,
      showScrollIndicator: true,
      renderRow: this.renderRow,
      detailFor: this.detailFor,
    });
  }

  handleInput(data: string): void {
    if (this.items.length === 0) return;
    if (matchesKey(data, "up")) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      return;
    }
    if (matchesKey(data, "enter")) {
      const item = this.items[this.selectedIndex];
      if (item && this.onSelect) this.onSelect(item);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.onCancel) this.onCancel();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// textInputDialog — single-line text input with backspace, paste support,
// and Esc to cancel.
// ---------------------------------------------------------------------------
export async function textInputDialog(
  ctx: ExtensionContext,
  opts: { title: string; label: string; hint?: string; initial?: string },
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let buffer = opts.initial ?? "";

    const inputDisplay = new (class {
      render() {
        return [`  ${theme.fg("accent", buffer || " ")}`];
      }
      invalidate() {}
    })();

    const container = titledBox(theme, opts.title, [
      new Text(theme.fg("muted", opts.label), 1, 0),
      inputDisplay,
      new Text(theme.fg("dim", opts.hint ?? "enter confirm • esc cancel"), 1, 0),
    ]);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
        if (matchesKey(data, "enter")) {
          const trimmed = buffer.trim();
          if (!trimmed) return;
          done(trimmed);
          return;
        }
        if (matchesKey(data, "backspace")) {
          buffer = buffer.slice(0, -1);
          tui.requestRender();
          return;
        }
        // Append printable characters (supports paste)
        const filtered = data.replace(/[\x00-\x1F\x7F]/g, "");
        if (filtered.length > 0) {
          buffer += filtered;
          tui.requestRender();
        }
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: DIALOG_WIDTH,
      minWidth: DIALOG_MIN_WIDTH,
      maxHeight: 8,
      margin: 4,
    },
  });
}

// ---------------------------------------------------------------------------
// SectionNavigator — generic helper for moving focus across multiple
// "sections" of items with arrow keys.  Used by the AssertsPanel to let
// the user navigate across local + repo groups.
// ---------------------------------------------------------------------------
export class SectionNavigator<T> {
  focus = 0;
  selection: number[];

  constructor(public sections: { items: T[] }[]) {
    this.selection = sections.map(() => 0);
  }

  get focusedSection(): number {
    return this.focus;
  }

  get focusedIndex(): number {
    return this.selection[this.focus] ?? 0;
  }

  get focusedItem(): T | undefined {
    return this.sections[this.focus]?.items[this.focusedIndex];
  }

  /** Move focus one item within the current section. Returns true if moved. */
  moveWithin(key: "up" | "down"): boolean {
    const sec = this.sections[this.focus];
    if (!sec) return false;
    const idx = this.selection[this.focus];

    if (key === "up" && idx > 0) {
      this.selection[this.focus]--;
      return true;
    }
    if (key === "down" && idx < sec.items.length - 1) {
      this.selection[this.focus]++;
      return true;
    }
    return false;
  }

  /**
   * Cross-section arrow: at the top of a section, ↑ wraps to the bottom of
   * the previous section; at the bottom, ↓ wraps to the top of the next.
   * Returns true if the navigator moved (caller should skip delegating to
   * the inner list).
   */
  cross(key: "up" | "down"): boolean {
    const sec = this.sections[this.focus];
    if (!sec) return false;
    const idx = this.selection[this.focus];

    if (key === "up" && idx === 0 && this.focus > 0) {
      this.focus--;
      this.selection[this.focus] = this.sections[this.focus].items.length - 1;
      return true;
    }
    if (key === "down" && idx >= sec.items.length - 1 && this.focus < this.sections.length - 1) {
      this.focus++;
      this.selection[this.focus] = 0;
      return true;
    }
    return false;
  }
}
