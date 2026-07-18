import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Component,
  Container,
  matchesKey,
  Key,
  Input,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type KeyId,
  type SelectItem,
  type SizeValue,
} from "@earendil-works/pi-tui";
import { highlightSegments } from "./fuzzy.js";

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

function bindingMatches(
  keybindings: KeybindingsManager | undefined,
  data: string,
  id: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  fallback: KeyId,
): boolean {
  return typeof keybindings?.matches === "function"
    ? keybindings.matches(data, id)
    : matchesKey(data, fallback);
}

// Text measurement and wrapping come from pi-tui (`visibleWidth`,
// `wrapTextWithAnsi`) so the whole project uses one ANSI-aware, wide-char
// aware implementation.  The detail-block helpers below build on those.

/**
 * Detail-block source for {@link renderAssertDetail}: either a shell assert
 * (`shell`, optional `when`) or a preset (`preset` refs).  Both fields are
 * optional so a `ShellAssert | PresetAssert` (the `Assert` union) is assignable
 * directly; {@link renderAssertDetail} dispatches on `preset` first.
 */
export interface AssertDetailEntry {
  shell?: string;
  when?: string;
  preset?: string[];
}

/**
 * Render the `shell:` / `when:` (or `asserts:` for a preset) detail block used
 * by both the /asserts panel and the install wizard's assert-entry picker.
 * `when` is only shown when present, matching the standard assert view.
 *
 * Dispatches on `preset` first so the shell branch is only reached for a shell
 * assert (whose `shell` is always present) — `detailLines(entry.shell, …)`
 * never receives `undefined` at runtime.  A preset renders `asserts:` with its
 * refs comma-joined, wrapped ANSI-aware so long ref lists carry across lines.
 */
export function renderAssertDetail(
  theme: Theme,
  width: number,
  entry: AssertDetailEntry,
  /**
   * When set (search mode), matched subsequence chars in `shell`/`when` are
   * highlighted via `highlightSegments`; otherwise the values render muted.
   * The install wizard never passes this.
   */
  query?: string,
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const muted = (s: string) => theme.fg("muted", s);
  const highlight = (s: string) => theme.fg("accent", theme.underline(s));

  const indent = 4;

  const lines: string[] = [];

  // One helper for both `shell` and `when` so the label/wrap/highlight
  // logic lives in a single place.  The value is styled once — segment-
  // highlighted on a match, otherwise muted in full — then wrapped.
  // `wrapTextWithAnsi` is ANSI-aware: it wraps by visible width and
  // re-applies active codes on each continuation line, so highlights (and
  // the muted base) carry across line breaks.
  const detailLines = (value: string, label: string): void => {
    const contentWidth = Math.max(1, width - indent - label.length);
    const segs = query ? highlightSegments(query, value) : null;
    const styled = segs
      ? segs.map((s) => (s.matched ? highlight(s.text) : muted(s.text))).join("")
      : muted(value);
    const wrapped = wrapTextWithAnsi(styled, contentWidth);
    for (let i = 0; i < wrapped.length; i++) {
      if (i === 0) {
        lines.push(" ".repeat(indent) + dim(label) + wrapped[i]!);
      } else {
        lines.push(" ".repeat(indent + label.length) + wrapped[i]!);
      }
    }
  };

  // Dispatch on `preset` first: a preset renders `asserts:` with its refs
  // comma-joined.  The shell branch is only reached for a shell assert, whose
  // `shell` is always present — so `detailLines(entry.shell, …)` never
  // receives `undefined` at runtime.  The `!== undefined` guard is the
  // type-safe encoding of that invariant (no `!` needed).
  if (entry.preset !== undefined) {
    detailLines(entry.preset.join(", "), "asserts: ");
    return fitLines(lines, width);
  }
  if (entry.shell !== undefined) detailLines(entry.shell, "shell: ");
  if (entry.when) detailLines(entry.when, "when: ");

  return fitLines(lines, width);
}

// ---------------------------------------------------------------------------
// Shared hint-line format
//
// Every panel and dialog uses the same style: `key` segments in accent and
// `action` segments in dim, joined by ` · ` with a 2-space indent.  The
// segment constants below keep the vocabulary consistent; `renderHintLine`
// and the `HintLine` component are the single place that handles greedy,
// whole-item wrapping when the line is too long.
// ---------------------------------------------------------------------------
export const HINT_ENTER_SELECT: [string, string] = ["Enter", "select"];
export const HINT_ENTER_OPEN: [string, string] = ["Enter", "open"];
export const HINT_ENTER_INSTALL: [string, string] = ["Enter", "install"];
export const HINT_ENTER_UPDATE: [string, string] = ["Enter", "update"];
export const HINT_ENTER_UNINSTALL: [string, string] = ["Enter", "remove"];
export const HINT_ENTER_CONFIRM: [string, string] = ["Enter", "confirm"];
export const HINT_ENTER_ENABLE: [string, string] = ["Enter", "toggle"];
export const HINT_ENTER_TOGGLE: [string, string] = ["Enter", "toggle"];
export const HINT_ESC_CANCEL: [string, string] = ["Esc", "cancel"];
export const HINT_ESC_BACK: [string, string] = ["Esc", "back"];
export const HINT_ESC_SAVE_BACK: [string, string] = ["Esc", "save & back"];
export const HINT_ESC_EXIT_SEARCH: [string, string] = ["Esc", "exit search"];
export const HINT_T_TOGGLE_DEFAULT: [string, string] = ["t", "Toggle default"];
export const HINT_D_DISABLE_ALL: [string, string] = ["d", "Disable all"];
export const HINT_R_REMOVE: [string, string] = ["r", "Remove"];
export const HINT_I_INSTALL_ASSERTS: [string, string] = ["i", "Install rules"];
export const HINT_N_NEW_PRESET: [string, string] = ["n", "New preset"];
export const HINT_E_EDIT_PRESET: [string, string] = ["e", "Edit preset"];
export const HINT_SEARCH: [string, string] = ["/", "search"];

/**
 * A hint segment: a `[key, action]` pair, optionally with a third `disabled`
 * flag.  A disabled item renders the whole `key action` run dim + struck
 * through, signalling an action that exists but doesn't apply to the focused
 * row (e.g. `e Edit preset` on a non-local, read-only preset).  The existing
 * `HINT_*` constants are `[string, string]` and stay valid — a 2-tuple is a
 * member of this union.
 */
export type HintItem = [string, string] | [string, string, boolean];

/** Format a single hint segment (no indent/separator). */
function formatHintItem(
  theme: Theme,
  item: HintItem,
  keybindings?: KeybindingsManager,
): string {
  const [rawKey, action, disabled] = item;
  const binding = rawKey === "Enter"
    ? "tui.select.confirm"
    : rawKey === "Esc"
      ? "tui.select.cancel"
      : null;
  const configured = binding && typeof keybindings?.getKeys === "function"
    ? keybindings.getKeys(binding).map(String).join("/")
    : "";
  const key = configured || rawKey;
  if (disabled) {
    return theme.strikethrough(theme.fg("dim", `${key} ${action}`));
  }
  return theme.fg("accent", key) + theme.fg("dim", " " + action);
}

/** Format the full hint line from hint segments. */
function formatHint(
  theme: Theme,
  items: HintItem[],
  keybindings?: KeybindingsManager,
): string {
  const dim = (s: string) => theme.fg("dim", s);
  const indent = dim("  ");
  const separator = dim(" · ");
  return indent + items
    .map((i) => formatHintItem(theme, i, keybindings))
    .join(separator);
}

/** ANSI-safe final width guard for custom component output. */
export function fitLines(lines: string[], width: number): string[] {
  const safeWidth = Math.max(0, width);
  return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

/**
 * Render a hint line that wraps greedily at whole segments when it would
 * exceed `width`.  Returns one or two lines so long hints never break a key
 * away from its description.
 */
export function renderHintLine(
  theme: Theme,
  width: number | undefined,
  items: HintItem[],
  keybindings?: KeybindingsManager,
): string[] {
  const single = formatHint(theme, items, keybindings);
  if (width === undefined) return [single];
  if (visibleWidth(single) <= width) return fitLines([single], width);

  // Greedy whole-item wrapping with no two-line assumption.
  const lines: string[] = [];
  let current: HintItem[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (current.length > 0 &&
        visibleWidth(formatHint(theme, candidate, keybindings)) > width) {
      lines.push(formatHint(theme, current, keybindings));
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(formatHint(theme, current, keybindings));
  return fitLines(lines, width);
}

/** Component wrapper around `renderHintLine` that receives the dialog width. */
class HintLine implements Component {
  constructor(
    private theme: Theme,
    private items: HintItem[],
    private keybindings?: KeybindingsManager,
  ) {}

  render(width: number): string[] {
    return renderHintLine(this.theme, width, this.items, this.keybindings);
  }

  invalidate() {}
}

// ---------------------------------------------------------------------------
// Shared overlay width for all install-flow dialogs so every window stays
// the same size. Fixed character width, with a matching floor so narrow
// terminals still get a usable minimum.
// ---------------------------------------------------------------------------
const DIALOG_WIDTH = 80;
const DIALOG_MIN_WIDTH = 24;

// ---------------------------------------------------------------------------
// OverlayBox — the single owner of the pi-assert overlay background.
//
// `customMessageBg` is the theme's designated distinct message/overlay
// background slot (the same one pi uses for custom / compaction / branch /
// skill message boxes), not the terminal session background, so every
// pi-assert overlay reads as a consistent surface regardless of theme.
//
// Every overlay (the /asserts panel and every install-flow dialog) goes
// through here so the background choice lives in one place.  Padding
// defaults to 0 so wrapping existing content doesn't reshape it; the
// /asserts panel passes (2, 1) to keep its inset.
// ---------------------------------------------------------------------------
export class OverlayBox extends Box {
  constructor(theme: Theme, paddingX = 0, paddingY = 0) {
    super(paddingX, paddingY, (s: string) => theme.bg("customMessageBg", s));
  }
}

// ---------------------------------------------------------------------------
// titledBox — wrap arbitrary content in DynamicBorder / Text pieces inside
// an OverlayBox so the titled border, title, body, and hint all share the
// overlay background.  Returns a Container ready to be returned from
// ctx.ui.custom's render.
// ---------------------------------------------------------------------------
function titledBox(theme: Theme, title: string, children: Component[]): Container {
  const box = new OverlayBox(theme);
  box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  box.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
  for (const c of children) box.addChild(c);
  box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  const container = new Container();
  container.addChild(box);
  return container;
}

// ---------------------------------------------------------------------------
// dialogShell — the shared overlay scaffolding for every install-flow
// dialog.  Wraps a body component in a titled box with a hint line, wires
// the overlay options (centered, fixed width, margin), and returns the
// `{render, invalidate, handleInput}` triple `ctx.ui.custom` expects.
//
// `selectDialog` and `textInputDialog` both build on this so the titled
// border + hint + overlay geometry live in one place; each only supplies
// its body component and input handler.
// ---------------------------------------------------------------------------
interface DialogShellOptions {
  title: string;
  /** Body component rendered between the title border and the hint. */
  body: Component;
  /** Hint segments as `[key, action]` pairs, rendered via `HintLine`. */
  hint?: [string, string][];
  /** Default hint segments when the caller omits one. */
  defaultHint?: [string, string][];
  /**
   * Override the hint with a custom component (e.g. a dynamic, focus-aware
   * hint that re-reads the selection on each render).  When set, `hint` and
   * `defaultHint` are ignored.
   */
  hintComponent?: Component;
  keybindings?: KeybindingsManager;
}

function dialogShell(
  theme: Theme,
  opts: DialogShellOptions,
): {
  render: (w: number) => string[];
  invalidate: () => void;
} {
  const hintComp =
    opts.hintComponent ??
    new HintLine(
      theme,
      opts.hint ?? opts.defaultHint ?? [HINT_ENTER_SELECT, HINT_ESC_CANCEL],
      opts.keybindings,
    );

  const container = titledBox(theme, opts.title, [opts.body, hintComp]);

  return {
    render: (w: number) => fitLines(container.render(w), w),
    invalidate: () => container.invalidate(),
  };
}

/** Shared overlay options for every pi-assert overlay (dialogs and the /asserts panel). */
export function dialogOverlay(maxHeight: SizeValue) {
  return {
    overlay: true as const,
    overlayOptions: {
      anchor: "center" as const,
      width: DIALOG_WIDTH,
      minWidth: DIALOG_MIN_WIDTH,
      maxHeight,
      margin: 4,
    },
  };
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
//
// `initialIndex`/`mark`/`remove` tailor the entry picker: `initialIndex`
// reopens on the same row after a reload; `mark` renders a leading badge
// *outside* the accent wrap (so a coloured mark keeps its colour on the
// selected row); `remove` enables `r` → inline `y/n` confirm, mirroring the
// /asserts panel.
// ---------------------------------------------------------------------------

/** {@link selectDialog} outcome: chosen value (or null), last highlighted index, and whether the user confirmed a removal. */
export interface SelectDialogResult<T> {
  value: T | null;
  /** Last highlighted row — pass back as `initialIndex` to remember position across reloads. */
  index: number;
  /** `true` when the user pressed `r` then `y` on a removable item. */
  removed: boolean;
}

export async function selectDialog<T>(
  ctx: ExtensionContext,
  opts: {
    title: string;
    items: SelectItem[];
    /** Hint segments as `[key, action]` pairs, rendered via `formatHint`. */
    hint?: [string, string][];
    maxVisible?: number;
    /** Resolve the shell/when (or preset `asserts:`) preview for a given item value. */
    detailFor?: (value: string) => AssertDetailEntry | undefined;
    /** Start the highlight at this index (clamped to the list). */
    initialIndex?: number;
    /** Leading per-item badge rendered before the label, outside the accent wrap. Return "" for no mark. */
    mark?: (item: SelectItem) => string;
    /** Enable the `r` Remove keybinding; `canRemove` gates which items are removable. */
    remove?: { canRemove: (item: SelectItem) => boolean };
    /**
     * Focus-aware dynamic hint.  Called with the currently highlighted item
     * on each render, so the hintline reflects the focused row's next action
     * (e.g. install / update / uninstall).  Takes precedence over `hint`.
     */
    hintFor?: (item: SelectItem) => [string, string][];
    /**
     * Require a `y/n` confirm before `Enter` resolves the select for items
     * where `shouldConfirm` returns true (e.g. a destructive uninstall).
     * On confirm the select resolves **normally** (`removed: false`) — the
     * caller classifies the result; the confirm is purely a guard.
     */
    confirmOnSelect?: {
      shouldConfirm: (item: SelectItem) => boolean;
      /** Confirm dialog title (default "Remove assert"). */
      title?: string;
      /** Confirm message builder (default `Remove "{value}"?`). */
      message?: (item: SelectItem) => string;
    };
  },
): Promise<SelectDialogResult<T>> {
  const hasDetail = !!opts.detailFor;
  const maxHeight = Math.min(
    opts.items.length + (hasDetail ? 12 : 4),
    hasDetail ? 24 : 16,
  );

  return ctx.ui.custom<SelectDialogResult<T>>((tui, theme, kb, done) => {
    const max = opts.maxVisible ?? Math.min(opts.items.length, hasDetail ? 10 : 12);

    // Widest mark reserves a badge column; marks render outside the accent
    // wrap so a coloured mark keeps its colour on the selected row.
    const markFn = opts.mark;
    const badgeW = markFn
      ? opts.items.reduce(
          (w, it) => Math.max(w, visibleWidth(markFn(it) ?? "")),
          0,
        )
      : 0;

    // Label column: widest label + 2-char gap, clamped to a sane range.
    const primary = Math.min(
      Math.max(
        opts.items.reduce((w, it) => Math.max(w, visibleWidth(it.label)), 0) + 2,
        8,
      ),
      40,
    );

    const renderRow = (item: SelectItem, selected: boolean, w: number): string => {
      const rawBadge = markFn?.(item) ?? "";
      const badge =
        badgeW > 0 ? rawBadge + " ".repeat(badgeW - visibleWidth(rawBadge)) : "";
      const label = truncateToWidth(item.label, primary - 2, "");
      const labelPad = " ".repeat(Math.max(1, primary - visibleWidth(label)));
      const descStart = 2 + badgeW + primary; // prefix(2) + badge + primary column
      const descRemaining = Math.max(0, w - descStart - 2);
      if (item.description && descRemaining > 10) {
        const desc = truncateToWidth(item.description, descRemaining, "");
        const body = `${label}${labelPad}${desc}`;
        return selected
          ? `${badge}${theme.fg("accent", body)}`
          : `${badge}${label}${theme.fg("muted", labelPad + desc)}`;
      }
      return selected
        ? `${badge}${theme.fg("accent", label)}`
        : `${badge}${label}`;
    };

    const list = new DetailList<SelectItem>(
      opts.items,
      max,
      theme,
      renderRow,
      (item) => opts.detailFor?.(item.value),
      kb,
    );
    if (opts.initialIndex !== undefined && opts.items.length > 0) {
      list.selectedIndex = Math.max(
        0,
        Math.min(opts.initialIndex, opts.items.length - 1),
      );
    }
    list.onSelect = (item) => {
      // Enter on a confirmable item swaps to the confirm shell instead of
      // resolving immediately.  The confirm resolves the select NORMALLY
      // (removed: false); the caller classifies the result.  This is the
      // guard for destructive Enter actions (e.g. uninstall).
      if (opts.confirmOnSelect?.shouldConfirm(item)) {
        confirmItem = item;
        confirmIsRemove = false;
        tui.requestRender();
        return;
      }
      done({ value: item.value as T, index: list.selectedIndex, removed: false });
    };
    list.onCancel = () =>
      done({ value: null, index: list.selectedIndex, removed: false });

    // Dynamic, focus-aware hint: re-reads the highlighted item on each render
    // so the hintline reflects the focused row's next action.
    const hintComponent = opts.hintFor
      ? ({
          render: (w: number) => {
            const item = opts.items[list.selectedIndex];
            const items = item
              ? opts.hintFor!(item)
              : (opts.hint ?? [HINT_ENTER_SELECT, HINT_ESC_CANCEL]);
            return renderHintLine(theme, w, items, kb);
          },
          invalidate() {},
        } as Component)
      : undefined;

    const shell = dialogShell(theme, {
      title: opts.title,
      body: list,
      hint: opts.hint,
      hintComponent,
      keybindings: kb,
    });

    // A confirm shell is needed when either the `r` Remove flow or the
    // `confirmOnSelect` Enter flow can trigger a confirm.  Both reuse the same
    // `confirmItem` state; `confirmIsRemove` distinguishes the `r`-triggered
    // path (resolves `removed: true`) from the Enter-triggered confirm
    // (resolves `removed: false`, caller classifies).
    const hasConfirm = !!opts.remove || !!opts.confirmOnSelect;
    let confirmItem: SelectItem | null = null;
    let confirmIsRemove = false;
    const confirmShell = hasConfirm
      ? dialogShell(theme, {
          title: opts.confirmOnSelect?.title ?? "Remove assert",
          body: {
            render: () => {
              const item = confirmItem;
              if (opts.confirmOnSelect?.message && item) {
                return [opts.confirmOnSelect.message(item)];
              }
              return [`  Remove "${item?.value ?? ""}"?`];
            },
            invalidate() {},
          } as Component,
          hint: [
            ["y", "confirm"],
            ["n", "cancel"],
          ],
          keybindings: kb,
        })
      : null;

    return {
      render: (w: number) =>
        confirmItem && confirmShell ? confirmShell.render(w) : shell.render(w),
      invalidate: () => {
        shell.invalidate();
        confirmShell?.invalidate();
      },
      handleInput: (data: string) => {
        if (confirmItem) {
          if (matchesKey(data, "y")) {
            done({
              value: confirmItem.value as T,
              index: list.selectedIndex,
              removed: confirmIsRemove,
            });
            return;
          }
          if (matchesKey(data, "n") || bindingMatches(kb, data, "tui.select.cancel", Key.escape)) {
            confirmItem = null;
            tui.requestRender();
            return;
          }
          return; // ignore other keys while confirming
        }

        if (matchesKey(data, "r") && opts.remove) {
          const item = opts.items[list.selectedIndex];
          if (item && opts.remove.canRemove(item)) {
            confirmItem = item;
            confirmIsRemove = true;
          } else {
            ctx.ui.notify("Only installed asserts can be removed", "info");
          }
          tui.requestRender();
          return;
        }

        list.handleInput(data);
        tui.requestRender();
      },
    };
  }, dialogOverlay(maxHeight));
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
  /** Resolve the shell/when (or preset `asserts:`) preview for an item. `undefined` skips the detail. */
  detailFor: (item: T) => AssertDetailEntry | undefined;
  /**
   * Optional lines rendered above the shell/when detail block for the
   * focused row (e.g. the `/asserts` panel's "removed from source repo"
   * warning for orphaned asserts).  Returns `[]` for no prefix.
   */
  detailPrefix?: (item: T) => string[];
  /**
   * When set, the shell/when detail block highlights query matches (search
   * mode).  Omitted by the install wizard, which has no search.
   */
  highlightQuery?: string;
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
      const prefixLines = opts.detailPrefix?.(item) ?? [];
      for (const l of prefixLines) lines.push(l);
      const entry = detailFor(item);
      if (entry) lines.push(...renderAssertDetail(theme, width, entry, opts.highlightQuery));
    }
  }

  if (opts.showScrollIndicator && (start > 0 || end < len)) {
    lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${len})`));
  }

  return fitLines(lines, width);
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
    private detailFor: (item: T) => AssertDetailEntry | undefined,
    private keybindings?: KeybindingsManager,
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
    const matches = (id: "tui.select.up" | "tui.select.down" |
      "tui.select.confirm" | "tui.select.cancel", fallback: KeyId): boolean =>
      bindingMatches(this.keybindings, data, id, fallback);
    if (matches("tui.select.up", "up")) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      return;
    }
    if (matches("tui.select.down", "down")) {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      return;
    }
    if (matches("tui.select.confirm", "enter")) {
      const item = this.items[this.selectedIndex];
      if (item && this.onSelect) this.onSelect(item);
      return;
    }
    if (matches("tui.select.cancel", Key.escape)) {
      if (this.onCancel) this.onCancel();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// filterPrintable — strip control chars, keep everything else (incl. space).
// Shared by `textInputDialog` and the `/asserts` panel search mode so paste
// works and Space is a valid query character. Mirrors the inline
// `data.replace(/[\x00-\x1F\x7F]/g, "")` previously in textInputDialog.
// ---------------------------------------------------------------------------
export function filterPrintable(data: string): string {
  return data.replace(/[\x00-\x1F\x7F]/g, "");
}

// ---------------------------------------------------------------------------
// textInputDialog — single-line text input with backspace, paste support,
// and Esc to cancel.
// ---------------------------------------------------------------------------
export async function textInputDialog(
  ctx: ExtensionContext,
  opts: {
    title: string;
    label: string;
    /** Hint segments as `[key, action]` pairs, rendered via `formatHint`. */
    hint?: [string, string][];
    initial?: string;
    /** Permit a trimmed empty value (descriptions are schema-valid when empty). */
    allowEmpty?: boolean;
    /** Return an error message to keep the dialog open. */
    validate?: (value: string) => string | null;
  },
): Promise<string | null> {
  const maxHeight = 8;

  return ctx.ui.custom<string | null>((tui, theme, kb, done) => {
    const input = new Input();
    input.setValue(opts.initial ?? "");

    const body = new Container();
    body.addChild(new Text(theme.fg("muted", opts.label), 1, 0));
    body.addChild(input);

    const shell = dialogShell(theme, {
      title: opts.title,
      body,
      hint: opts.hint,
      defaultHint: [HINT_ENTER_CONFIRM, HINT_ESC_CANCEL],
      keybindings: kb,
    });

    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: shell.render,
      invalidate: shell.invalidate,
      handleInput: (data: string) => {
        if (bindingMatches(kb, data, "tui.select.cancel", Key.escape)) {
          done(null);
          return;
        }
        if (bindingMatches(kb, data, "tui.select.confirm", "enter")) {
          const value = input.getValue().trim();
          if (!opts.allowEmpty && !value) return;
          const error = opts.validate?.(value);
          if (error) {
            ctx.ui.notify(error, "warning");
            return;
          }
          done(value);
          return;
        }
        input.handleInput(data);
        tui.requestRender();
      },
    };
  }, dialogOverlay(maxHeight));
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
   * Discrete cycle jump: `Tab` → next section, `Shift+Tab` → previous,
   * wrapping last→first and first→last.  Unlike `cross`, this is a
   * deliberate jump that preserves each section's remembered index — Tab
   * away and Shift+Tab back returns to the same row (the standard
   * "tab between fields" metaphor).  Returns `false` (no-op) when there
   * are fewer than two sections.
   */
  cycleSection(dir: "next" | "prev"): boolean {
    if (this.sections.length < 2) return false;
    const n = this.sections.length;
    this.focus =
      dir === "next" ? (this.focus + 1) % n : (this.focus - 1 + n) % n;
    return true;
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

// ---------------------------------------------------------------------------
// Sectioned-body windowing geometry — pure helpers shared by every
// sectioned panel (the `/asserts` panel and the preset editor's assert
// picker) so the two views share one windowing implementation (no drift).
//
// The focused section is the anchor: its header + a windowed slice of its
// rows + the focused row's detail block are always shown.  The immediate
// prev/next section headers are always shown (with a blank separator each).
// Farther inactive section headers fill remaining space greedily (above
// then below, alternating).  All pure: no I/O, no rendering — callers render
// according to the returned plan.
// ---------------------------------------------------------------------------

/**
 * `[start, end)` row window for a section of `len` items with `selected`
 * focused, showing at most `visible` rows centred on the selection.  Clamps
 * to the section bounds; returns `[0, len]` when everything fits.
 */
function sectionWindow(
  visible: number,
  selected: number,
  len: number,
): [number, number] {
  if (visible >= len) return [0, len];
  const half = Math.floor((visible - 1) / 2);
  let start = selected - half;
  let end = start + visible;
  if (start < 0) {
    start = 0;
    end = visible;
  }
  if (end > len) {
    end = len;
    start = len - visible;
  }
  return [start, end];
}

/** Layout plan for a sectioned body (see {@link layoutSectionedBody}). */
export interface SectionedLayout {
  /** `[start, end)` row window for the focused section. */
  activeWindow: [number, number];
  /** Whether the focused section needs a `(i/n)` scroll indicator. */
  windowed: boolean;
  /** Show the previous section header (`focusedSection > 0`). */
  showPrev: boolean;
  /** Show the next section header (`focusedSection < count - 1`). */
  showNext: boolean;
  /** Inactive section indices above the focused section, farthest-first. */
  inactiveAbove: number[];
  /** Inactive section indices below the focused section, nearest-first. */
  inactiveBelow: number[];
}

/**
 * Compute the viewport plan for a sectioned body with one focused (anchor)
 * section.  Pure: given the section count, the focused section/index, the
 * focused section's row count, the focused row's detail-block height, and
 * the content lines available (header/query/hint already subtracted by the
 * caller), returns which sections to show and the focused section's row
 * window.
 *
 * `inactiveHeaderHeight` (default 1) is the line count of one inactive
 * section header; each inactive header costs `inactiveHeaderHeight + 1`
 * (header + blank separator) lines.
 */
export function layoutSectionedBody(opts: {
  sectionCount: number;
  focusedSection: number;
  focusedIndex: number;
  activeLen: number;
  detailBlockHeight: number;
  /** Content lines available (header/query/hint already subtracted). */
  available: number;
  /** Lines one inactive section header occupies (default 1). */
  inactiveHeaderHeight?: number;
}): SectionedLayout {
  const inactiveH = opts.inactiveHeaderHeight ?? 1;
  const { sectionCount, focusedSection, focusedIndex, activeLen, detailBlockHeight, available } = opts;

  const showPrev = focusedSection > 0;
  const showNext = focusedSection < sectionCount - 1;
  const reserved = 1 + (showPrev ? 2 : 0) + (showNext ? 2 : 0);
  const contentBudget = Math.max(1, available - reserved);
  let activeVisible = Math.min(activeLen, Math.max(1, contentBudget - detailBlockHeight));
  const windowed = activeLen > activeVisible;
  if (windowed) activeVisible = Math.max(1, activeVisible - 1);

  const activeWindow = sectionWindow(activeVisible, focusedIndex, activeLen);

  // Greedy fill of inactive section headers around the anchor.  Each costs
  // `inactiveH + 1` (header + separator); add above then below alternately
  // while they fit.
  const coreHeight = reserved + activeVisible + detailBlockHeight + (windowed ? 1 : 0);
  const stepCost = inactiveH + 1;
  let remaining = available - coreHeight;
  let above = focusedSection - (showPrev ? 2 : 1);
  let below = focusedSection + (showNext ? 2 : 1);
  const inactiveAbove: number[] = [];
  const inactiveBelow: number[] = [];
  let progressed = true;
  while (remaining > 0 && (above >= 0 || below < sectionCount) && progressed) {
    progressed = false;
    if (above >= 0 && stepCost <= remaining) {
      inactiveAbove.unshift(above); // farthest ends up first (top-down render)
      remaining -= stepCost;
      above--;
      progressed = true;
    }
    if (below < sectionCount && stepCost <= remaining) {
      inactiveBelow.push(below);
      remaining -= stepCost;
      below++;
      progressed = true;
    }
  }
  return { activeWindow, windowed, showPrev, showNext, inactiveAbove, inactiveBelow };
}
