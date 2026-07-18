/**
 * Preset editor's assert picker — a sectioned, searchable panel that *is* the
 * `/asserts` view (sections by source, fzf-style search, Tab/Shift+Tab
 * cross-section navigation, `sectionHeaderKeys` jump hints) but with checkbox
 * semantics: `Enter` toggles membership (`✓`), `Esc` commits + goes back.
 *
 * Inherits the entire composition path (`render`/`bodyLines`/windowing/
 * `renderSectionHeader`/`moveFocus`) AND the shared input (`handleSearchInput`/`
 * `handleNavInput`/`toggleFocused`) from `SectionedPanel` — the same path the
 * `/asserts` panel uses.  This class supplies only the panel-specific hooks:
 * header, hint, `renderSection` (badge column = ✓/space membership), the
 * empty-state message, and the one panel-specific key (`Esc` = commit).  No
 * parallel render, search, or navigation path — one shared implementation
 * (see AGENTS.md).
 */

import {
  type ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Key,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { isPreset, type Assert, type PresetAssert } from "../engine.js";
import {
  HINT_ENTER_TOGGLE,
  HINT_ESC_BACK,
  HINT_ESC_EXIT_SEARCH,
  HINT_SEARCH,
  OverlayBox,
  SectionNavigator,
  dialogOverlay,
  renderDetailList,
  renderHintLine,
} from "./components.js";
import { highlightSegments } from "./fuzzy.js";
import { SectionedPanel, type Group, groupShellBySource } from "./sectioned-panel.js";
import type { AssertsState } from "./state.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** `runPresetEditor` outcome: chosen refs (in item order) + last index. */
export interface PresetEditorResult {
  /** `"source/name"` refs in item order. `Esc` commits (no cancel here). */
  value: string[];
  /** Last focused row (for restoring highlight on re-entry). */
  index: number;
}

// ---------------------------------------------------------------------------
// PresetEditorPanel
// ---------------------------------------------------------------------------

type PanelResult = PresetEditorResult | undefined;

export class PresetEditorPanel extends SectionedPanel {
  /** Working copy of the selected `"source/name"` refs (toggled by Space). */
  private selected: Set<string>;
  private _theme!: Theme;

  private shellAsserts: Assert[];
  /** Original order preserves dangling/nested refs on an otherwise no-op edit. */
  private initialOrder: string[];

  constructor(
    shellAsserts: Assert[],
    private presetName: string,
    private description: string,
    selected: Iterable<string>,
  ) {
    super();
    // Self-filter presets: the picker offers only shell asserts, so even if a
    // caller passes the full assert list, presets never appear as pickable rows.
    this.shellAsserts = shellAsserts.filter((a) => !isPreset(a));
    this.groups = groupShellBySource(this.shellAsserts);
    this.nav = new SectionNavigator(
      this.groups.map((g) => ({ items: g.asserts })),
    );
    this.initialOrder = Array.from(selected);
    this.selected = new Set(this.initialOrder);
    // Open on the first non-empty section so the user lands on a real row.
    const firstNonEmpty = this.groups.findIndex((g) => g.asserts.length > 0);
    if (firstNonEmpty >= 0) this.nav.focus = firstNonEmpty;
  }

  protected canSearch(): boolean {
    return this.shellAsserts.length > 0;
  }

  protected get theme(): Theme {
    return this._theme;
  }

  setTheme(theme: Theme): void {
    this._theme = theme;
  }

  /** The `"source/name"` ref for an assert (matches `activeList()`'s split). */
  private refOf(a: Assert): string {
    return `${a.source}/${a.name}`;
  }

  /** The committed selection, retaining refs that have no selectable row. */
  get value(): string[] {
    const original = this.initialOrder.filter((ref) => this.selected.has(ref));
    const originalSet = new Set(this.initialOrder);
    // Newly selected visible asserts append in picker order. Existing refs
    // retain their exact order, including dangling and nested-preset refs.
    const added = this.shellAsserts
      .map((a) => this.refOf(a))
      .filter((ref) => this.selected.has(ref) && !originalSet.has(ref));
    return [...original, ...added];
  }

  // ── Hooks (implement SectionedPanel abstracts / overrides) ────────
  protected renderHeaderLines(): string[] {
    const t = this.theme;
    const title = t.fg("accent", t.bold("Edit preset"));
    const namePart = t.fg("muted", ` — ${this.presetName}`);
    const desc = this.description
      ? t.fg("dim", this.description)
      : t.fg("dim", "(no description)");
    return [`${title}${namePart}`, desc, ""];
  }

  protected emptyBodyLines(_width: number): string[] {
    return [
      ...this.renderHeaderLines(),
      this.theme.fg("warning", "  No shell asserts to select"),
    ];
  }

  protected hintLine(width?: number): string[] {
    if (this.searchActive) {
      return renderHintLine(this.theme, width, [
        HINT_ENTER_TOGGLE,
        HINT_ESC_EXIT_SEARCH,
      ]);
    }
    return renderHintLine(this.theme, width, [
      HINT_ENTER_TOGGLE,
      HINT_SEARCH,
      HINT_ESC_BACK,
    ]);
  }

  protected renderSection(
    width: number,
    group: Group,
    focused: boolean,
    selectedIndex: number,
    start = 0,
    end = group.asserts.length,
  ): string[] {
    const theme = this.theme;
    const CHECK = theme.fg("success", "✓");
    const EMPTY = theme.fg("dim", " ");
    const CHECK_W = visibleWidth(CHECK);

    // Label width = name + check badge (1), so the description column aligns.
    const maxLabelWidth = Math.max(
      0,
      ...group.asserts.map((a) => a.name.length + CHECK_W),
    );

    if (!focused) {
      // Dimmed static listing (no `> ` prefix, no detail block) — mirrors
      // `AssertsPanel.renderSection`'s inactive branch so inactive sections
      // read as context, not as selectable rows.
      const muted = (s: string) => theme.fg("muted", s);
      const lines: string[] = [];
      for (const a of group.asserts) {
        const badge = this.selected.has(this.refOf(a)) ? CHECK : EMPTY;
        const labelW = a.name.length + CHECK_W;
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const descText = a.description ? muted(a.description) : "";
        lines.push(`   ${badge} ${muted(a.name)}${padding}  ${descText}`);
      }
      return lines;
    }

    return renderDetailList(theme, width, {
      items: group.asserts,
      selectedIndex,
      window: [start, end],
      showScrollIndicator: false,
      highlightQuery: this.searchActive ? this.query : undefined,
      renderRow: (a, selected) => {
        const isMember = this.selected.has(this.refOf(a));
        const badge = isMember ? CHECK : EMPTY;
        const labelW = a.name.length + CHECK_W;
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const base = selected
          ? (s: string) => theme.fg("accent", s)
          : (s: string) => s;
        const highlight = selected
          ? (s: string) => theme.fg("accent", theme.underline(s))
          : (s: string) => theme.fg("accent", s);
        const nameText = this.renderName(a, base, highlight, padding);
        const descText = a.description
          ? base(a.description)
          : "";
        return `${badge} ${nameText}  ${descText}`;
      },
      detailFor: (a) =>
        isPreset(a) ? { preset: a.preset } : { shell: a.shell, when: a.when },
    });
  }

  /**
   * Render the name with query matches highlighted, then `padding` aligned
   * to the label column. Mirrors `AssertsPanel.renderLabel` so search
   * highlighting is consistent between the two views.
   */
  private renderName(
    a: Assert,
    base: (s: string) => string,
    highlight: (s: string) => string,
    padding: string,
  ): string {
    const segs =
      this.searchActive ? highlightSegments(this.query, a.name) : null;
    if (!segs) return base(a.name + padding);
    return (
      segs
        .map((s) => (s.matched ? highlight(s.text) : base(s.text)))
        .join("") + base(padding)
    );
  }

  // ── Input ──────────────────────────────────────────────────────────
  handleInput(data: string): PanelResult {
    // Search + navigation are shared with the `/asserts` panel (single-sourced
    // in `SectionedPanel.handleSearchInput`/`handleNavInput`).  The only
    // panel-specific key is `Esc`, which commits the working selection and
    // goes back (vs. `/asserts`, where `Esc` cancels).
    if (this.handleSearchInput(data)) return undefined;
    if (matchesKey(data, Key.escape)) return this.commit();
    if (this.handleNavInput(data)) return undefined;
    return undefined;
  }

  /** Toggle the focused assert's membership in the selection. */
  protected toggleFocused(): void {
    const focused = this.groups[this.nav.focusedSection];
    const selected = focused?.asserts[this.nav.focusedIndex];
    if (!selected) return;
    const ref = this.refOf(selected);
    if (this.selected.has(ref)) this.selected.delete(ref);
    else this.selected.add(ref);
  }

  /** Commit the current selection (in item order). */
  private commit(): PanelResult {
    return { value: this.value, index: this.nav.focusedIndex };
  }
}

// ---------------------------------------------------------------------------
// runPresetEditor — show the panel and resolve with the selection.
// ---------------------------------------------------------------------------
export async function runPresetEditor(
  ctx: ExtensionContext,
  state: AssertsState,
  preset: PresetAssert,
  description: string,
): Promise<PresetEditorResult> {
  const shellAsserts = state.asserts.filter((a) => !isPreset(a));
  const initial = new Set(preset.preset);

  return ctx.ui.custom<PresetEditorResult>((tui, theme, _kb, done) => {
    const panel = new PresetEditorPanel(shellAsserts, preset.name, description, initial);
    panel.setTheme(theme);

    const panelHeight = Math.max(10, Math.floor(tui.terminal.rows * 0.8) - 2);

    const panelComponent = {
      render: (w: number) => panel.render(w, panelHeight),
      invalidate: () => {},
      handleInput: () => {},
    };

    const box = new OverlayBox(theme, 2, 1);
    box.addChild(panelComponent);

    const container = new Container();
    container.addChild(box);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const result = panel.handleInput(data);
        if (result) done(result);
        tui.requestRender();
      },
    };
  }, dialogOverlay("80%"));
}
