import { type ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Assert } from "../engine.js";
import { fetchRepoEntries, removeRule, setAssertDefault } from "../installer.js";
import {
  HINT_D_DISABLE_ALL,
  HINT_ENTER_ENABLE,
  HINT_ESC_CANCEL,
  HINT_ESC_EXIT_SEARCH,
  HINT_I_INSTALL_ASSERTS,
  HINT_R_REMOVE,
  HINT_T_TOGGLE_DEFAULT,
  OverlayBox,
  SectionNavigator,
  dialogOverlay,
  filterPrintable,
  renderAssertDetail,
  renderDetailList,
  renderHintLine,
} from "./components.js";
import { filterSection, highlightSegments } from "./fuzzy.js";
import type { AssertsState } from "./state.js";
import { runInstallWizard } from "./install.js";

// ---------------------------------------------------------------------------
// Group: an ordered list of asserts that share a `source`.
// ---------------------------------------------------------------------------
interface Group {
  source: string;
  asserts: Assert[];
}

// Order: "local" first, then repos alphabetically.
function groupBySource(asserts: Assert[]): Group[] {
  const bySource = new Map<string, Assert[]>();
  for (const a of asserts) {
    const list = bySource.get(a.source) ?? [];
    list.push(a);
    bySource.set(a.source, list);
  }
  return Array.from(bySource.keys())
    .sort((a, b) => {
      if (a === "local") return -1;
      if (b === "local") return 1;
      return a.localeCompare(b);
    })
    .map((source) => ({ source, asserts: bySource.get(source)! }));
}

// ---------------------------------------------------------------------------
// AssertsPanel — model + render + input for the /asserts toggle UI.
// ---------------------------------------------------------------------------
type PanelAction = "cancel" | "install" | "reload";

export class AssertsPanel {
  groups: Group[];
  nav: SectionNavigator<Assert>;
  private confirm: { name: string; source: string } | null = null;

  // ── Search mode state ─────────────────────────────────────────────
  // During search `this.groups` / `this.nav` are swapped to filtered
  // versions (a subset of the originals, same `Assert` object references);
  // `bodyLines` / `renderSection` / windowing all run unchanged against
  // the filtered model. `savedGroups` / `savedNav` hold the originals and
  // are restored on `Esc`. This is the one shared implementation — no
  // parallel render path (see AGENTS.md).
  private searchActive = false;
  private query = "";
  private savedGroups: Group[] | null = null;
  private savedNav: SectionNavigator<Assert> | null = null;
  /** Whether search state is currently exposed (used by tests). */
  get isSearchActive(): boolean { return this.searchActive; }

  /**
   * Composite keys (`${source}\0${name}`) of installed asserts that no longer
   * exist in their source repo (removed upstream).  Keyed by source+name so a
   * local assert (or a different repo's assert) sharing a name with an
   * orphaned repo assert is never mis-badged.  Populated asynchronously by
   * `startOrphanCheck`; empty until the fetch settles.  Local asserts are
   * never orphaned.
   */
  private orphaned = new Set<string>();

  /** Re-render trigger, set by the caller so async fetch resolution can flip badges in. */
  private requestRender: () => void = () => {};

  // ── Search lifecycle ───────────────────────────────────────────────
  /** Enter fuzzy-search mode. No-op when there's nothing to search. */
  private enterSearch(): void {
    if (this.state.broken || this.groups.length === 0) return;
    this.searchActive = true;
    this.query = "";
    this.savedGroups = this.groups;
    this.savedNav = this.nav;
    this.applyFilter();
  }

  /** Exit search; restore focus to the highlighted match in the unfiltered view. */
  private exitSearch(): void {
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
  private appendQuery(data: string): void {
    const filtered = filterPrintable(data);
    if (!filtered) return;
    this.query += filtered;
    this.applyFilter();
  }

  /** Pop the last query char and re-filter (no-op on an empty query). */
  private popQuery(): void {
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
  private applyFilter(): void {
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
  private restoreFocus(a: Assert | undefined): void {
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

  constructor(private state: AssertsState) {
    this.groups = groupBySource(state.asserts);
    this.nav = new SectionNavigator<Assert>(
      this.groups.map((g) => ({ items: g.asserts })),
    );
  }

  /** Wire the TUI re-render trigger (called inside `ctx.ui.custom`). */
  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  /**
   * Kick off async repo fetches to detect orphaned asserts — installed names
   * missing from their source repo.  When all fetches settle, populates
   * `orphaned` and triggers a re-render so `⚠` badges appear.
   *
   * Skipped entirely when the config is broken (hard-fail posture) or when
   * there are no repo-sourced asserts.  Network failures degrade silently:
   * a repo that can't be fetched contributes no orphaned entries (no `⚠`),
   * and the session cache means the next open retries.
   */
  startOrphanCheck(): void {
    if (this.state.broken) return;

    const repos = new Set<string>();
    for (const a of this.state.asserts) {
      if (a.source !== "local") repos.add(a.source);
    }
    if (repos.size === 0) return;

    // Fetch each repo's entries (session-cached per repo@ref).
    const fetches = [...repos].map(async (repo) => {
      try {
        return [repo, await fetchRepoEntries(repo)] as const;
      } catch {
        return null; // network failure → no orphaned detection for this repo
      }
    });

    Promise.all(fetches).then((results) => {
      const orphaned = new Set<string>();
      for (const result of results) {
        if (!result) continue;
        const [repo, entries] = result;
        for (const a of this.state.asserts) {
          if (a.source === repo && !entries.has(a.name)) {
            orphaned.add(`${a.source}\0${a.name}`);
          }
        }
      }
      this.orphaned = orphaned;
      this.requestRender();
    });
  }

  // ── Render ─────────────────────────────────────────────────────────
  // `render` is the single emission point: it always returns header + body +
  // a blank separator + a hint line.  The individual branches in `bodyLines`
  // never append the hint themselves, so no mode (empty / confirm / bounded /
  // unbounded) can forget it — the bug that prompted this structure.
  render(width: number, terminalHeight?: number): string[] {
    const hintLines = this.hintLine(width);
    const body = this.bodyLines(width, terminalHeight, hintLines.length);
    const rendered = [...body, "", ...hintLines];
    if (terminalHeight !== undefined && rendered.length > terminalHeight) {
      return rendered.slice(0, terminalHeight);
    }
    return rendered;
  }

  /** Header + content for the current mode, WITHOUT the trailing hint — that's `render`'s job. */
  private bodyLines(
    width: number,
    terminalHeight: number | undefined,
    hintLen: number,
  ): string[] {
    // Search filtered to zero matches must take precedence over the normal
    // empty-panel branch: a zero-match view shows "No matches", never
    // "No asserts defined!".
    if (this.searchActive && this.groups.length === 0) {
      return [
        ...this.renderHeaderLines(),
        this.renderSearchQueryLine(width),
        this.theme.fg("warning", "  No matches"),
      ];
    }

    if (this.groups.length === 0) {
      return [
        ...this.renderHeaderLines(),
        this.theme.fg(
          "dim",
          "No asserts defined! Prompt your agent or press " +
            this.theme.fg("accent", "i") +
            " to install.",
        ),
      ];
    }

    if (this.confirm) {
      return [
        ...this.renderHeaderLines(),
        "",
        `  Remove "${this.confirm.name}"?`,
      ];
    }

    if (terminalHeight === undefined) {
      return this.renderUnboundedBody(width);
    }

    // Header (3 lines) and footer (1 blank + hint line(s)) are reserved.
    // The active section is the anchor; adjacent section headers are always
    // shown. Detail lines for the selected assert are rendered inline
    // directly below the highlighted assert row, so the active section's
    // line budget includes both assert rows and the selected row's details.
    const headerLines = this.renderHeaderLines();
    const queryLine = this.searchActive ? this.renderSearchQueryLine(width) : null;
    const available =
      terminalHeight - headerLines.length - (queryLine ? 1 : 0) - 1 - hintLen;
    const focusedSection = this.nav.focusedSection;
    const activeGroup = this.groups[focusedSection];
    const activeLen = activeGroup.asserts.length;
    const selectedAssert = activeGroup.asserts[this.nav.focusedIndex];
    const detailBlock = selectedAssert
      ? [
          ...this.orphanedDetailLines(selectedAssert),
          ...renderAssertDetail(this.theme, width, selectedAssert),
        ]
      : [];

    // Always reserve space for the previous/next section headers and the
    // separators between them and the active section.
    const showPrev = focusedSection > 0;
    const showNext = focusedSection < this.groups.length - 1;
    const reserved =
      1 + // active section header
      (showPrev ? 2 : 0) + // prev header + separator
      (showNext ? 2 : 0); // next header + separator

    const contentBudget = Math.max(1, available - reserved);
    let activeVisible = Math.min(
      activeLen,
      Math.max(1, contentBudget - detailBlock.length),
    );
    const windowed = activeLen > activeVisible;
    if (windowed) {
      activeVisible = Math.max(1, activeVisible - 1); // scroll indicator
    }

    const [start, end] = this.activeWindow(activeVisible);

    let coreLines: string[] = [
      this.renderSectionHeader(focusedSection),
      ...this.renderSection(
        width,
        activeGroup,
        true,
        this.nav.focusedIndex,
        start,
        end,
      ),
    ];

    if (windowed) {
      coreLines.push(
        this.theme.fg(
          "dim",
          `  (${this.nav.focusedIndex + 1}/${activeLen})`,
        ),
      );
    }

    // Always show the immediate previous and next section headers.
    if (showPrev) {
      coreLines = [
        this.renderSectionHeader(focusedSection - 1),
        "",
        ...coreLines,
      ];
    }
    if (showNext) {
      coreLines = [
        ...coreLines,
        "",
        this.renderSectionHeader(focusedSection + 1),
      ];
    }

    // Add any farther sections that still fit.
    let lines: string[] = [...coreLines];

    let remaining = available - lines.length;
    let above = focusedSection - (showPrev ? 2 : 1);
    let below = focusedSection + (showNext ? 2 : 1);

    let progressed = true;
    while (
      remaining > 0 &&
      (above >= 0 || below < this.groups.length) &&
      progressed
    ) {
      progressed = false;
      if (above >= 0) {
        const block = this.renderInactiveSectionHeader(above);
        if (block.length + 1 <= remaining) {
          lines = [...block, "", ...lines];
          remaining -= block.length + 1;
          above--;
          progressed = true;
        }
      }
      if (below < this.groups.length) {
        const block = this.renderInactiveSectionHeader(below);
        if (block.length + 1 <= remaining) {
          lines = [...lines, "", ...block];
          remaining -= block.length + 1;
          below++;
          progressed = true;
        }
      }
    }

    return [...headerLines, ...(queryLine ? [queryLine] : []), ...lines];
  }

  private renderUnboundedBody(width: number): string[] {
    const lines: string[] = [];
    if (this.searchActive) lines.push(this.renderSearchQueryLine(width));
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i];
      const isFocused = i === this.nav.focusedSection;
      lines.push(this.renderSectionHeader(i));
      lines.push(...this.renderSection(width, g, isFocused, this.nav.focusedIndex));
      if (i < this.groups.length - 1) lines.push("");
    }
    return [...this.renderHeaderLines(), ...lines];
  }

  /** The `/query▏` line shown at the top of the body during search. */
  private renderSearchQueryLine(width: number): string {
    const prompt = "/" + this.query;
    const truncated = truncateToWidth(prompt, Math.max(1, width - 3));
    return `  ${this.theme.fg("accent", truncated)}▏`;
  }

  private renderHeaderLines(): string[] {
    return [
      this.theme.fg("accent", this.theme.bold("Asserts")),
      this.theme.fg(
        "muted",
        `${this.state.active.size}/${this.state.asserts.length} active`,
      ),
      "",
    ];
  }

  // ── Render helpers ─────────────────────────────────────────────────
  /** The plain row label: `name` plus the optional ` (default)` tag. */
  private plainLabel(a: Assert): string {
    return a.default ? `${a.name} (default)` : a.name;
  }

  /**
   * Render the name (+ optional " (default)" suffix) with query matches
   * highlighted, then `padding` aligned to the label column.
   *
   * `base` styles unmatched text (and the suffix + padding); `highlight`
   * styles matched chars.  When search is inactive or the name doesn't
   * match, the whole name+suffix+padding is styled via `base` as a single
   * run — byte-identical to the pre-highlight render (so the empty-padding
   * and column-alignment cases are unchanged).  ANSI codes are zero visible
   * width, so highlighting never disturbs the padding math.
   */
  private renderLabel(
    a: Assert,
    base: (s: string) => string,
    highlight: (s: string) => string,
    padding: string,
  ): string {
    const segs =
      this.searchActive ? highlightSegments(this.query, a.name) : null;
    if (!segs) return base(this.plainLabel(a) + padding);
    const suffix = a.default ? " (default)" : "";
    return (
      segs
        .map((s) => (s.matched ? highlight(s.text) : base(s.text)))
        .join("") + base(suffix + padding)
    );
  }

  private renderSectionHeader(index: number): string {
    const group = this.groups[index];
    const focused = index === this.nav.focusedSection;
    const header = group.source === "local" ? "Local" : group.source;
    const color = focused ? "accent" : "muted";
    const keys = this.sectionNavKeys(index);
    const keyHint = keys.length
      ? "  " + keys.map((k) => this.theme.fg("accent", k)).join(this.theme.fg("dim", " · "))
      : "";
    return `  ${this.theme.fg(color, header)}${keyHint}`;
  }

  /**
   * The Tab/Shift+Tab cycle keys that land on `index`, so the section
   * header advertises the jump in place instead of as a separate hint-line
   * item.  Empty for the focused section (already there) and for sections
   * that aren't a direct cycle target.  With wrap, the first/last section
   * is reachable from the opposite end, so it carries the key too.
   */
  private sectionNavKeys(index: number): string[] {
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

  private renderSection(
    width: number,
    group: Group,
    focused: boolean,
    selectedIndex: number,
    start = 0,
    end = group.asserts.length,
  ): string[] {
    if (!focused) {
      // Dimmed static listing.
      const orphaned = this.orphaned;
      const orphanW = visibleWidth(this.theme.fg("warning", "⚠ "));
      const isOrphaned = (a: Assert) =>
        orphaned.has(`${a.source}\0${a.name}`);
      const maxLabelWidth = Math.max(
        ...group.asserts.map(
          (a) => this.plainLabel(a).length + (isOrphaned(a) ? orphanW : 0),
        ),
      );
      const lines: string[] = [];
      const muted = (s: string) => this.theme.fg("muted", s);
      const accent = (s: string) => this.theme.fg("accent", s);
      for (const a of group.asserts) {
        const badge = isOrphaned(a)
          ? this.theme.fg("warning", "⚠ ")
          : "";
        const labelW =
          this.plainLabel(a).length + (isOrphaned(a) ? orphanW : 0);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const status = this.state.active.has(a.name)
          ? this.theme.fg("muted", "enabled")
          : this.theme.fg("dim", "disabled");
        lines.push(
          `   ${badge}${this.renderLabel(a, muted, accent, padding)}  ${status}`,
        );
      }
      return lines;
    }

    // Active section: delegate to the shared renderDetailList so the row
    // layout, "> " highlight prefix, and inline shell/when detail block are
    // identical to the install wizard's assert-entry picker.  We pass our
    // own [start, end) window (the panel manages per-section scrolling and
    // renders its own scroll indicator outside the section).
    //
    // Orphaned asserts (removed upstream) get a `⚠` badge rendered OUTSIDE
    // the accent wrap so it keeps its warning colour on the selected row;
    // the badge width is reserved in `maxLabelWidth` so the status column
    // stays aligned across marked and unmarked rows.
    const theme = this.theme;
    const active = this.state.active;
    const orphaned = this.orphaned;
    const isOrphaned = (a: Assert) => orphaned.has(`${a.source}\0${a.name}`);
    const orphanBadge = (a: Assert) =>
      isOrphaned(a) ? theme.fg("warning", "⚠ ") : "";
    const orphanW = visibleWidth(theme.fg("warning", "⚠ "));
    const maxLabelWidth = Math.max(
      ...group.asserts.map(
        (a) => this.plainLabel(a).length + (isOrphaned(a) ? orphanW : 0),
      ),
    );

    return renderDetailList(theme, width, {
      items: group.asserts,
      selectedIndex,
      window: [start, end],
      showScrollIndicator: false,
      highlightQuery: this.searchActive ? this.query : undefined,
      renderRow: (a, selected) => {
        const badge = orphanBadge(a);
        const status = active.has(a.name) ? "enabled" : "disabled";
        const labelW =
          this.plainLabel(a).length + (isOrphaned(a) ? orphanW : 0);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const base = selected
          ? (s: string) => theme.fg("accent", s)
          : (s: string) => s;
        const highlight = selected
          ? (s: string) => theme.fg("accent", theme.underline(s))
          : (s: string) => theme.fg("accent", s);
        const labelText = this.renderLabel(a, base, highlight, padding);
        const valueText = selected
          ? theme.fg("accent", status)
          : theme.fg("dim", status);
        return `${badge}${labelText}  ${valueText}`;
      },
      detailFor: (a) => ({ shell: a.shell, when: a.when }),
      detailPrefix: (a) => this.orphanedDetailLines(a),
    });
  }

  /**
   * Contextual warning line shown in the detail block under a focused
   * orphaned assert — explains what the `⚠` badge means and how to act on
   * it.  Returns `[]` for non-orphaned asserts so the detail block is
   * unchanged.
   */
  private orphanedDetailLines(a: Assert): string[] {
    if (!this.orphaned.has(`${a.source}\0${a.name}`)) return [];
    return [
      "    " +
        this.theme.fg("warning", "⚠ ") +
        this.theme.fg("dim", "removed from source repo — press r to uninstall"),
    ];
  }

  private renderInactiveSectionHeader(index: number): string[] {
    return [this.renderSectionHeader(index)];
  }

  /** Return the [start, end) slice of the active section that stays visible. */
  private activeWindow(visible: number): [number, number] {
    const group = this.groups[this.nav.focusedSection];
    const len = group.asserts.length;
    if (visible >= len) return [0, len];

    const selected = this.nav.focusedIndex;
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

  /** The one hint source — confirm-aware so `render`'s tail always emits the right hint. */
  private hintLine(width?: number): string[] {
    if (this.confirm) {
      return renderHintLine(this.theme, width, [
        ["y", "confirm"],
        ["n", "cancel"],
      ]);
    }

    if (this.searchActive) {
      return renderHintLine(this.theme, width, [
        HINT_ENTER_ENABLE,
        HINT_ESC_EXIT_SEARCH,
      ]);
    }

    const items: [string, string][] = [
      HINT_ENTER_ENABLE,
      HINT_T_TOGGLE_DEFAULT,
    ];
    if (this.state.active.size > 0) {
      items.push(HINT_D_DISABLE_ALL);
    }
    items.push(HINT_R_REMOVE);
    items.push(HINT_I_INSTALL_ASSERTS);
    items.push(HINT_ESC_CANCEL);
    return renderHintLine(this.theme, width, items);
  }

  // ── Theme access ───────────────────────────────────────────────────
  // We capture the theme at construction time (passed in by ctx.ui.custom).
  // The `!` is safe: the panel is always created and rendered inside
  // `ctx.ui.custom(...)`, which calls `setTheme(theme)` before the
  // first `render()`.  TypeScript can't see that ordering, so we assert
  // definite assignment.
  private _theme!: Theme;

  setTheme(theme: Theme): void {
    this._theme = theme;
  }

  private get theme(): Theme {
    return this._theme;
  }

  // ── Input ──────────────────────────────────────────────────────────
  /**
   * Handle a key.  Returns a string when the panel wants the dialog to
   * close (cancel / install / reload), or `undefined` to keep going.
   */
  handleInput(data: string, ctx: ExtensionContext): PanelAction | undefined {
    // ── Confirmation mode ──
    if (this.confirm) {
      if (matchesKey(data, "y")) {
        const { name, source } = this.confirm;
        removeRule(ctx.cwd, source, name);
        this.state.disable(name);
        this.state.persist();
        this.confirm = null;
        return "reload";
      }
      if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
        this.confirm = null;
        return undefined;
      }
      return undefined;
    }

    // ── Search mode (fzf-style inline filter) ──
    // Whitelist navigators + Enter + Tab + Esc + Backspace; everything else
    // (incl. Space and `r`/`t`/`d`/`i`) feeds the query. `r`/`t`/`d`/`i` are
    // unreachable until `Esc` exits search.
    if (this.searchActive) {
      if (matchesKey(data, Key.escape))    { this.exitSearch(); return undefined; }
      if (matchesKey(data, "backspace"))   { this.popQuery();   return undefined; }
      if (matchesKey(data, "enter"))      { this.toggleFocused(ctx); return undefined; }
      if (matchesKey(data, "up"))         { this.moveFocus("up");   return undefined; }
      if (matchesKey(data, "down"))       { this.moveFocus("down"); return undefined; }
      if (matchesKey(data, Key.tab))       { this.nav.cycleSection("next"); return undefined; }
      if (matchesKey(data, Key.shift("tab"))) { this.nav.cycleSection("prev"); return undefined; }
      this.appendQuery(data); // filterPrintable inside; no-op for bare controls
      return undefined;
    }

    // ── Global hotkeys ──
    if (matchesKey(data, "/")) { this.enterSearch(); return undefined; }
    if (matchesKey(data, "i")) return "install";
    if (matchesKey(data, Key.escape)) return "cancel";

    const focused = this.groups[this.nav.focusedSection];
    if (!focused) return undefined;

    // ── d: disable all active asserts (no-op when none active) ──
    if (matchesKey(data, "d")) {
      if (this.state.active.size === 0) return undefined;
      this.state.disableAll();
      this.state.persist();
      this.state.updateStatus(ctx);
      return undefined;
    }

    // ── r: remove selected assert ──
    if (matchesKey(data, "r")) {
      const selected = focused.asserts[this.nav.focusedIndex];
      if (selected) {
        this.confirm = { name: selected.name, source: focused.source };
      }
      return undefined;
    }

    // ── t: toggle on-disk `default` flag (per-session active set untouched) ──
    if (matchesKey(data, "t")) {
      const selected = focused.asserts[this.nav.focusedIndex];
      if (!selected) return undefined;

      if (!selected.path) {
        ctx.ui.notify(
          `pi-assert: cannot locate "${selected.name}" on disk`,
          "error",
        );
        return undefined;
      }

      try {
        const next = !selected.default;
        setAssertDefault(selected.path, focused.source, selected.name, next);

        // Mirror the new value to the in-memory `Assert` so the next render
        // shows the (default) tag.  The panel's `group.asserts` array shares
        // object references with `state.asserts` (both were built from the
        // same `loadAsserts` result), so mutating the live entry mutates
        // both views.  Reloading here would create new objects and break
        // that link.
        const live = this.state.asserts.find(
          (a) => a.source === focused.source && a.name === selected.name,
        );
        if (live) live.default = next;
      } catch (err) {
        ctx.ui.notify(
          `pi-assert: failed to toggle default — ${String(err)}`,
          "error",
        );
      }
      return undefined;
    }

    // ── Enter: toggle (Space is no longer a binding — it's a query char in
    // search mode and resolves to a no-op in normal mode). ──
    if (matchesKey(data, "enter")) {
      this.toggleFocused(ctx);
      return undefined;
    }

    // ── Tab / Shift+Tab: cycle focus between sections (local + repos) ──
    // A discrete jump that preserves each section's remembered row — Tab
    // away and Shift+Tab back returns to the same assert.  No-op with a
    // single section.  `matchesKey("\t", "t")` is false (distinct
    // codepoints), so Tab never collides with the `t` toggle-default key.
    if (matchesKey(data, Key.tab)) {
      this.nav.cycleSection("next");
      return undefined;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.nav.cycleSection("prev");
      return undefined;
    }

    // ── Arrows: cross-section first, then within ──
    if (matchesKey(data, "up"))    { this.moveFocus("up");   return undefined; }
    if (matchesKey(data, "down"))  { this.moveFocus("down"); return undefined; }

    return undefined;
  }

  // ── Shared input helpers (used by both modes) ───────────────────────
  /** Move focus one step, crossing to the adjacent section at the boundary. */
  private moveFocus(dir: "up" | "down"): void {
    if (this.nav.cross(dir)) return;
    this.nav.moveWithin(dir);
  }

  /** Toggle the active state of the currently focused assert. */
  private toggleFocused(ctx: ExtensionContext): void {
    const focused = this.groups[this.nav.focusedSection];
    const selected = focused?.asserts[this.nav.focusedIndex];
    if (!selected) return;
    if (this.state.active.has(selected.name)) this.state.disable(selected.name);
    else this.state.enable(selected.name);
    this.state.persist();
    this.state.updateStatus(ctx);
  }
}

// ---------------------------------------------------------------------------
// runAssertsCommand — shows the panel, runs install on demand, and loops
// back so a freshly installed rule is immediately toggleable.
// ---------------------------------------------------------------------------
export function registerAssertsCommand(
  pi: ExtensionAPI,
  state: AssertsState,
): void {
  pi.registerCommand("asserts", {
    description: "Activate / deactivate asserts",
    handler: async (_args, ctx) => {
      // The `while (true)` loop is intentional: it re-enters the panel
      // after `install` and `reload` actions so freshly installed /
      // removed asserts are immediately toggleable.
      while (true) {
        state.load(ctx.cwd);
        // Prune stale active entries that no longer exist
        const validNames = new Set(state.asserts.map((a) => a.name));
        for (const name of Array.from(state.active)) {
          if (!validNames.has(name)) state.disable(name);
        }
        state.updateStatus(ctx);

        const action = await ctx.ui.custom<PanelAction | null>(
          (tui, theme, _kb, done) => {
            const panel = new AssertsPanel(state);
            panel.setTheme(theme);
            // Wire the re-render trigger so the async orphaned-check can
            // flip `⚠` badges in when `fetchRepoEntries` settles.
            panel.setRequestRender(() => tui.requestRender());
            panel.startOrphanCheck();

            const panelHeight = Math.max(
              10,
              Math.floor(tui.terminal.rows * 0.8) - 2,
            );

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
                const result = panel.handleInput(data, ctx);
                if (result) {
                  done(result === "cancel" ? null : result);
                }
                tui.requestRender();
              },
            };
          },
          dialogOverlay("80%"),
        );

        if (action === "install") {
          await runInstallWizard(ctx, state);
          continue;
        }
        if (action === "reload") {
          continue;
        }
        // null / cancel
        break;
      }
    },
  });
}
