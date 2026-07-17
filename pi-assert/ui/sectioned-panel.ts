/**
 * Shared base for sectioned panels with fzf-style search — the `/asserts`
 * panel and the preset editor's assert picker.  Single-sources the search
 * lifecycle (enter/exit/append/pop/apply/restore), the `/query▕` render
 * line, the sectioned-body composition (`render`/`bodyLines`/windowing/
 * `renderSectionHeader`/`moveFocus`), the section-header jump-key hints
 * (`Tab`/`Shift+Tab`), AND the shared input (search-mode block + normal-mode
 * navigation: `handleSearchInput`/`handleNavInput`) so the two views share
 * one implementation (no drift; see AGENTS.md "Prefer one shared implementation
 * over two").
 *
 * The search swaps `groups`/`nav` (not the renderer): during search they point
 * at filtered subsets of the same `Assert` object references; `bodyLines`,
 * `renderSection`, and windowing run unchanged against the filtered model.
 * Ranking is per-section (`filterSection`) so section grouping and order stay
 * stable while matches rank inside each section; empty sections drop out.
 *
 * Subclasses implement the abstract rendering hooks (`renderHeaderLines`,
 * `hintLine`, `renderSection`) and may override the optional hooks
 * (`emptyBodyLines`, `modeBodyLines`, `detailBlockFor`, `sectionHeaderKeys`).
 * The base owns the composition: `render` → `bodyLines` → `renderSectionHeader`
 * + `renderSection` + `layoutSectionedBody` windowing.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { Assert } from "../engine.js";
import {
  SectionNavigator,
  filterPrintable,
  layoutSectionedBody,
  renderAssertDetail,
} from "./components.js";
import { filterSection } from "./fuzzy.js";

/** An ordered list of asserts sharing a `source` (a display section). */
export interface Group {
  source: string;
  asserts: Assert[];
}

/**
 * Source sort order: `local` first, then the rest alphabetically.  Shared by
 * every sectioned panel so section order is stable and identical across views.
 */
function sortSources(sources: string[]): string[] {
  return sources.sort((a, b) => {
    if (a === "local") return -1;
    if (b === "local") return 1;
    return a.localeCompare(b);
  });
}

/**
 * Group shell asserts by `source` (local first, then repos alpha).  Presets
 * are **not** hoisted — callers that want a Presets section build it
 * themselves (the `/asserts` panel does; the preset editor's assert picker
 * offers only shell asserts).  Shared so the two views agree on section order.
 */
export function groupShellBySource(asserts: Assert[]): Group[] {
  const bySource = new Map<string, Assert[]>();
  for (const a of asserts) {
    const list = bySource.get(a.source) ?? [];
    list.push(a);
    bySource.set(a.source, list);
  }
  return sortSources([...bySource.keys()]).map(
    (source) => ({ source, asserts: bySource.get(source)! }),
  );
}

/**
 * Abstract base for a sectioned panel over `Assert` items with search.
 * Owns the search lifecycle, the query render line, and the sectioned-body
 * composition (`render`/`bodyLines`/windowing/headers/`moveFocus`).
 * Subclasses implement the abstract hooks and may override the optional ones.
 */
export abstract class SectionedPanel {
  groups!: Group[];
  nav!: SectionNavigator<Assert>;

  protected searchActive = false;
  protected query = "";
  protected savedGroups: Group[] | null = null;
  protected savedNav: SectionNavigator<Assert> | null = null;

  /** Whether search state is currently exposed (used by tests). */
  get isSearchActive(): boolean { return this.searchActive; }

  // ── Abstract hooks (subclass must implement) ──────────────────────
  /** Whether entering search is allowed (non-empty, non-broken model). */
  protected abstract canSearch(): boolean;

  /** Theme accessor (set by the subclass before the first render). */
  protected abstract get theme(): Theme;

  /** Header lines above the body (title, subtitle, blank). */
  protected abstract renderHeaderLines(): string[];

  /** The hint line(s) rendered at the bottom by `render`. */
  protected abstract hintLine(width?: number): string[];

  /** Render one section's rows (active or dimmed-inactive). */
  protected abstract renderSection(
    width: number,
    group: Group,
    focused: boolean,
    selectedIndex: number,
    start?: number,
    end?: number,
  ): string[];

  /**
   * Toggle the focused row's state — enable/disable in `/asserts`, membership
   * `✓` in the preset editor.  Called by the shared `Enter` binding (search +
   * normal mode), so both views toggle with the same key.
   */
  protected abstract toggleFocused(): void;

  // ── Optional hooks (subclass may override) ────────────────────────
  /** Whether the panel has zero items to show (drives the empty-state branch). */
  protected isEmpty(): boolean {
    return this.groups.every((g) => g.asserts.length === 0);
  }

  /** Body lines for the empty state.  Default: header only. */
  protected emptyBodyLines(_width: number): string[] {
    return this.renderHeaderLines();
  }

  /**
   * Body lines for a panel-specific mode that takes over the body (e.g. the
   * `/asserts` panel's confirm-remove).  Return `null` when the mode is
   * inactive so the normal render path runs.
   */
  protected modeBodyLines(_width: number): string[] | null {
    return null;
  }

  /** The detail block under the focused row.  Default: `renderAssertDetail`. */
  protected detailBlockFor(a: Assert | undefined, width: number): string[] {
    if (!a) return [];
    return renderAssertDetail(this.theme, width, a);
  }

  /**
   * Jump-key hints shown after the section header.  The base shows `Tab` /
   * `Shift+Tab` on the section a Tab / Shift+Tab cycle would land on (next /
   * prev relative to the focused section), so every sectioned panel advertises
   * the same cross-section navigation.  Subclasses may override to prepend
   * panel-specific jump keys (e.g. `/asserts` adds `p` for the Presets section).
   */
  protected sectionHeaderKeys(index: number): string[] {
    const n = this.groups.length;
    if (n < 2) return [];
    const focused = this.nav.focusedSection;
    if (index === focused) return [];
    const nextTarget = (focused + 1) % n;
    const prevTarget = (focused - 1 + n) % n;
    const keys: string[] = [];
    if (index === nextTarget) keys.push("Tab");
    if (index === prevTarget) keys.push("Shift+Tab");
    return keys;
  }

  // ── Composition (shared by every sectioned panel) ─────────────────
  /**
   * `render` is the single emission point: it always returns header + body +
   * a blank separator + a hint line.  The individual branches in `bodyLines`
   * never append the hint themselves, so no mode (empty / mode / bounded /
   * unbounded) can forget it.
   */
  render(width: number, terminalHeight?: number): string[] {
    const hintLines = this.hintLine(width);
    const body = this.bodyLines(width, terminalHeight, hintLines.length);
    const rendered = [...body, "", ...hintLines];
    if (terminalHeight !== undefined && rendered.length > terminalHeight) {
      return rendered.slice(0, terminalHeight);
    }
    return rendered;
  }

  /** Header + content for the current mode, WITHOUT the trailing hint. */
  protected bodyLines(
    width: number,
    terminalHeight: number | undefined,
    hintLen: number,
  ): string[] {
    // Search filtered to zero matches must take precedence over the normal
    // empty-panel branch: a zero-match view shows "No matches", never the
    // empty-panel message.
    if (this.searchActive && this.groups.length === 0) {
      return [
        ...this.renderHeaderLines(),
        this.renderSearchQueryLine(width),
        this.theme.fg("warning", "  No matches"),
      ];
    }

    if (this.isEmpty()) return this.emptyBodyLines(width);

    const mode = this.modeBodyLines(width);
    if (mode) return mode;

    if (terminalHeight === undefined) {
      return this.renderUnboundedBody(width);
    }

    // Header and footer (1 blank + hint line(s)) are reserved.  The active
    // section is the anchor; adjacent section headers are always shown.
    // Detail lines for the selected assert are rendered inline directly
    // below the highlighted assert row, so the active section's line budget
    // includes both assert rows and the selected row's details.  The
    // viewport geometry (which sections fit, the focused section's row
    // window) is `layoutSectionedBody`.
    const headerLines = this.renderHeaderLines();
    const queryLine = this.searchActive ? this.renderSearchQueryLine(width) : null;
    const available =
      terminalHeight - headerLines.length - (queryLine ? 1 : 0) - 1 - hintLen;
    const focusedSection = this.nav.focusedSection;
    const activeGroup = this.groups[focusedSection];
    const activeLen = activeGroup.asserts.length;
    const selectedAssert = activeGroup.asserts[this.nav.focusedIndex];
    const detailBlock = this.detailBlockFor(selectedAssert, width);

    const layout = layoutSectionedBody({
      sectionCount: this.groups.length,
      focusedSection,
      focusedIndex: this.nav.focusedIndex,
      activeLen,
      detailBlockHeight: detailBlock.length,
      available,
    });

    let coreLines: string[] = [
      this.renderSectionHeader(focusedSection),
      ...this.renderSection(
        width,
        activeGroup,
        true,
        this.nav.focusedIndex,
        layout.activeWindow[0],
        layout.activeWindow[1],
      ),
    ];

    if (layout.windowed) {
      coreLines.push(
        this.theme.fg("dim", `  (${this.nav.focusedIndex + 1}/${activeLen})`),
      );
    }

    // Always show the immediate previous and next section headers.
    if (layout.showPrev) {
      coreLines = [this.renderSectionHeader(focusedSection - 1), "", ...coreLines];
    }
    if (layout.showNext) {
      coreLines = [...coreLines, "", this.renderSectionHeader(focusedSection + 1)];
    }

    // Add any farther sections that fit.
    let lines: string[] = [...coreLines];
    for (const idx of layout.inactiveAbove) {
      lines = [...this.renderInactiveSectionHeader(idx), "", ...lines];
    }
    for (const idx of layout.inactiveBelow) {
      lines = [...lines, "", ...this.renderInactiveSectionHeader(idx)];
    }

    return [...headerLines, ...(queryLine ? [queryLine] : []), ...lines];
  }

  /** Unbounded body (no terminal height) — used by tests / headless renders. */
  protected renderUnboundedBody(width: number): string[] {
    const lines: string[] = [];
    if (this.searchActive) lines.push(this.renderSearchQueryLine(width));
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i]!;
      const isFocused = i === this.nav.focusedSection;
      lines.push(this.renderSectionHeader(i));
      lines.push(...this.renderSection(width, g, isFocused, this.nav.focusedIndex));
      if (i < this.groups.length - 1) lines.push("");
    }
    return [...this.renderHeaderLines(), ...lines];
  }

  /** Section header: `Local` / repo key, accent when focused, muted otherwise. */
  protected renderSectionHeader(index: number): string {
    const group = this.groups[index];
    const focused = index === this.nav.focusedSection;
    const header = group.source === "local" ? "Local" : group.source;
    const color = focused ? "accent" : "muted";
    const keys = this.sectionHeaderKeys(index);
    const keyHint = keys.length
      ? "  " + keys.map((k) => this.theme.fg("accent", k)).join(this.theme.fg("dim", " · "))
      : "";
    return `  ${this.theme.fg(color, header)}${keyHint}`;
  }

  /** Inactive section header (just the header line, no key hints). */
  protected renderInactiveSectionHeader(index: number): string[] {
    return [this.renderSectionHeader(index)];
  }

  /** Move focus one step, crossing to the adjacent section at the boundary. */
  protected moveFocus(dir: "up" | "down"): void {
    if (this.nav.cross(dir)) return;
    this.nav.moveWithin(dir);
  }

  // ── Shared input (search + navigation) ────────────────────────────
  // The search-mode block and the normal-mode navigation keys (`/` search,
  // Enter toggle, Tab/Shift+Tab cycle, arrows) are identical across every
  // sectioned panel — only the panel-specific action keys differ (and live in
  // the subclass `handleInput`).  Each subclass calls `handleSearchInput` first
  // (search pre-empts everything) and `handleNavInput` last (panel-specific
  // keys take precedence over plain navigation), so the shared keys are
  // single-sourced here (no drift; see AGENTS.md).

  /**
   * Handle the search-mode keys (Esc exit, Backspace pop, Enter toggle,
   * arrows, Tab/Shift+Tab cycle, else append query).  Returns `true` iff the
   * key was consumed — callers return `undefined` and stay open.  No-op
   * (returns `false`) when search is inactive, so the subclass can call it
   * unconditionally as the first input check.
   */
  protected handleSearchInput(data: string): boolean {
    if (!this.searchActive) return false;
    if (matchesKey(data, Key.escape))         { this.exitSearch(); return true; }
    if (matchesKey(data, "backspace"))        { this.popQuery();   return true; }
    if (matchesKey(data, "enter"))            { this.toggleFocused(); return true; }
    if (matchesKey(data, "up"))               { this.moveFocus("up");   return true; }
    if (matchesKey(data, "down"))             { this.moveFocus("down"); return true; }
    if (matchesKey(data, Key.tab))             { this.nav.cycleSection("next"); return true; }
    if (matchesKey(data, Key.shift("tab")))    { this.nav.cycleSection("prev"); return true; }
    this.appendQuery(data); // filterPrintable inside; no-op for bare controls
    return true;
  }

  /**
   * Handle the normal-mode navigation keys (`/` search, Enter toggle,
   * Tab/Shift+Tab cycle, arrows).  Returns `true` iff consumed.  Call this
   * last in the subclass `handleInput`, after the panel-specific keys, so
   * panel actions take precedence over plain navigation.
   */
  protected handleNavInput(data: string): boolean {
    if (matchesKey(data, "/"))              { this.enterSearch(); return true; }
    if (matchesKey(data, "enter"))         { this.toggleFocused(); return true; }
    if (matchesKey(data, Key.tab))          { this.nav.cycleSection("next"); return true; }
    if (matchesKey(data, Key.shift("tab"))) { this.nav.cycleSection("prev"); return true; }
    if (matchesKey(data, "up"))             { this.moveFocus("up");   return true; }
    if (matchesKey(data, "down"))           { this.moveFocus("down"); return true; }
    return false;
  }

  // ── Search lifecycle ───────────────────────────────────────────────
  /** Enter fuzzy-search mode. No-op when there's nothing to search. */
  protected enterSearch(): void {
    if (!this.canSearch()) return;
    this.searchActive = true;
    this.query = "";
    this.savedGroups = this.groups;
    this.savedNav = this.nav;
    this.applyFilter();
  }

  /** Exit search; restore focus to the highlighted match in the unfiltered view. */
  protected exitSearch(): void {
    const kept = this.groups[this.nav.focusedSection]?.asserts[this.nav.focusedIndex];
    this.groups = this.savedGroups ?? this.groups;
    this.nav = this.savedNav ?? this.nav;
    this.savedGroups = null;
    this.savedNav = null;
    this.searchActive = false;
    this.query = "";
    if (kept) this.restoreFocus(kept);
  }

  /** Append printable input to the query and re-filter. */
  protected appendQuery(data: string): void {
    const filtered = filterPrintable(data);
    if (!filtered) return;
    this.query += filtered;
    this.applyFilter();
  }

  /** Pop the last query char and re-filter (no-op on an empty query). */
  protected popQuery(): void {
    if (this.query.length === 0) return;
    this.query = this.query.slice(0, -1);
    this.applyFilter();
  }

  /**
   * Rebuild filtered `groups` / `nav` from `savedGroups` + the current
   * query, then restore focus to the previously-highlighted assert
   * (best-effort). Empty/whitespace-only query reproduces every section
   * unchanged (scores 0). Filtering keeps the same `Assert` references, so
   * `restoreFocus` can use identity (`indexOf`) lookup.
   */
  protected applyFilter(): void {
    const keep = this.groups[this.nav.focusedSection]?.asserts[this.nav.focusedIndex];
    const filtered = (this.savedGroups ?? this.groups)
      .map((g) => ({
        source: g.source,
        asserts: filterSection(this.query, g.asserts).map((m) => m.assert),
      }))
      .filter((g) => g.asserts.length > 0);
    this.groups = filtered;
    this.nav = new SectionNavigator(filtered.map((g) => ({ items: g.asserts })));
    this.restoreFocus(keep);
  }

  /** Point `nav` at `a`'s section/index in the current (filtered) groups. */
  protected restoreFocus(a: Assert | undefined): void {
    if (!a) {
      if (this.groups.length) { this.nav.focus = 0; this.nav.selection[0] = 0; }
      return;
    }
    for (let s = 0; s < this.groups.length; s++) {
      const idx = this.groups[s]!.asserts.indexOf(a); // identity (===)
      if (idx >= 0) {
        this.nav.focus = s;
        this.nav.selection[s] = idx;
        return;
      }
    }
    // `a` filtered out: stay in its source section if any filtered group
    // shares `a.source` (by string — section indices shift as empty
    // sections drop, so positional lookup is unsafe), else first match.
    const sec = this.groups.findIndex((g) => g.source === a.source);
    if (sec >= 0) {
      this.nav.focus = sec;
      this.nav.selection[sec] = 0;
      return;
    }
    if (this.groups.length) {
      this.nav.focus = 0;
      this.nav.selection[0] = 0;
    }
  }

  /** The `/query▏` line shown at the top of the body during search. */
  protected renderSearchQueryLine(width: number): string {
    const prompt = "/" + this.query;
    const truncated = truncateToWidth(prompt, Math.max(1, width - 3));
    return `  ${this.theme.fg("accent", truncated)}▏`;
  }
}
