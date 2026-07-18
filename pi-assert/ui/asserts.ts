import { type ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Key,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isPreset, type Assert, type PresetAssert } from "../engine.js";
import {
  fetchRepoEntries,
  installRule,
  removeRuleAt,
  setAssertDefault,
  editPresetRule,
} from "../installer.js";
import { projectFilePath } from "../config.js";
import {
  HINT_D_DISABLE_ALL,
  HINT_E_EDIT_PRESET,
  HINT_ENTER_ENABLE,
  HINT_ESC_CANCEL,
  HINT_ESC_EXIT_SEARCH,
  HINT_ENTER_CONFIRM,
  HINT_I_INSTALL_ASSERTS,
  HINT_N_NEW_PRESET,
  HINT_R_REMOVE,
  HINT_T_TOGGLE_DEFAULT,
  OverlayBox,
  SectionNavigator,
  dialogOverlay,
  renderAssertDetail,
  renderDetailList,
  renderHintLine,
  textInputDialog,
  type HintItem,
} from "./components.js";
import { highlightSegments } from "./fuzzy.js";
import { SectionedPanel, type Group, groupShellBySource } from "./sectioned-panel.js";
import { resolvePresetMembers, type AssertsState } from "./state.js";
import { runInstallWizard } from "./install.js";
import { runPresetEditor } from "./preset-editor.js";

// Order: always-present **Presets** section first (header shown even when
// empty, so `p`/`n` always have a home), then `local`, then repos alpha.
// Presets are hoisted out of their real source into the synthetic Presets
// group for display; write-back (`r`/`t`) uses `selected.source`/
// `selected.path` (the preset's real section), not the group label.
const PRESETS_SOURCE = "Presets";
function groupBySource(asserts: Assert[]): Group[] {
  const presets = asserts.filter(isPreset);
  const shell = asserts.filter((a) => !isPreset(a));
  return [{ source: PRESETS_SOURCE, asserts: presets }, ...groupShellBySource(shell)];
}

// ---------------------------------------------------------------------------
// Preset coverage — the reverse of `activeList()`'s expansion.
//
// For each shell assert that is a member of an **active** preset, this maps
// `source\x00name` → the names of the active presets that reference it.
// Mirrors `activeList()` exactly: only active presets contribute, dangling
// and nested-preset refs are skipped, refs split on the last `/`.  Used by
// `renderStatus` to show `active · via {preset}` on a member that isn't
// individually active but runs because an active preset expanded to it.
// ---------------------------------------------------------------------------
function buildPresetCoverage(
  asserts: Assert[],
  isActive: (assert: Assert) => boolean,
): Map<string, string[]> {
  const coverage = new Map<string, string[]>();
  for (const a of asserts) {
    if (!isActive(a) || !isPreset(a)) continue;
    for (const member of resolvePresetMembers(asserts, a)) {
      const key = `${member.source}\x00${member.name}`;
      const list = coverage.get(key) ?? [];
      list.push(a.name);
      coverage.set(key, list);
    }
  }
  return coverage;
}

// ---------------------------------------------------------------------------
// AssertsPanel — model + render + input for the /asserts toggle UI.
// ---------------------------------------------------------------------------
type PanelAction =
  | "cancel"
  | "install"
  | "reload"
  | "create-preset"
  | { type: "edit-preset"; preset: PresetAssert };

export class AssertsPanel extends SectionedPanel {
  private confirm: { name: string; source: string; path?: string } | null = null;

  /**
   * Composite keys (`${source}\0${name}`) of installed asserts that no longer
   * exist in their source repo (removed upstream).  Keyed by source+name so a
   * local assert (or a different repo's assert) sharing a name with an
   * orphaned repo assert is never mis-badged.  Populated asynchronously by
   * `startOrphanCheck`; empty until the fetch settles.  Local asserts are
   * never orphaned.
   */
  private orphaned = new Set<string>();

  /**
   * Reverse map: `source\x00name` → active preset names that reference it.
   * Lazy-computed and invalidated on toggle/disable-all (`_coverage = null`).
   * See {@link buildPresetCoverage}.
   */
  private _coverage: Map<string, string[]> | null = null;
  private get coverage(): Map<string, string[]> {
    if (this._coverage === null) {
      this._coverage = buildPresetCoverage(this.state.asserts, (a) => this.activeFor(a));
    }
    return this._coverage;
  }

  /**
   * Reverse lookup for dangling-ref detection: `"source/name"` → the installed
   * shell assert at that ref (presets excluded — a ref to a preset is a
   * nested-preset ref, always dangling for v1).  Lazy-computed once: the
   * panel is recreated after every reload (install/remove/create), and within
   * a panel instance `state.asserts` (which asserts exist) never changes —
   * only `active` and `default` flags do — so the map is stable for the
   * panel's lifetime.  Synchronous, unlike the async orphaned fetch.
   */
  private _byRef: Map<string, Assert> | null = null;
  private get byRef(): Map<string, Assert> {
    if (this._byRef === null) {
      this._byRef = new Map(
        this.state.asserts
          .filter((a) => !isPreset(a))
          .map((a) => [`${a.source}/${a.name}`, a]),
      );
    }
    return this._byRef;
  }

  /**
   * The refs of preset `a` that don't resolve to an installed shell assert.
   * Empty for non-presets and for presets whose every ref resolves.  A preset
   * is `§` (dangling) iff this is non-empty.  Refs split on the last `/`
   * (matches `activeList()`), but the lookup key is the full `"source/name"`
   * ref string, so a malformed ref (no `/`) simply won't be in the map.
   */
  private danglingRefs(a: Assert): string[] {
    if (!isPreset(a)) return [];
    const out: string[] = [];
    for (const ref of a.preset) {
      if (!this.byRef.has(ref)) out.push(ref);
    }
    return out;
  }

  /** `true` iff `a` is a preset with at least one dangling ref (`§` badge). */
  private isDangling(a: Assert): boolean {
    return this.danglingRefs(a).length > 0;
  }

  /** `true` iff `a` was removed from its source repo (`⚠` badge, async). */
  private isOrphaned(a: Assert): boolean {
    return this.orphaned.has(`${a.source}\0${a.name}`);
  }

  /** Re-render trigger, set by the caller so async fetch resolution can flip badges in. */
  private requestRender: () => void = () => {};

  /** Search guard: nothing to search when the config is broken or empty. */
  protected canSearch(): boolean {
    return !this.state.broken && this.state.asserts.length > 0;
  }

  constructor(private state: AssertsState) {
    super();
    this.groups = groupBySource(state.asserts);
    this.nav = new SectionNavigator<Assert>(
      this.groups.map((g) => ({ items: g.asserts })),
    );
    // Open on the first non-empty section so the user lands on a real row.
    // The Presets section is always first but may be empty; falling back to
    // it (index 0) when every section is empty keeps `p`/`n` reachable.
    const firstNonEmpty = this.groups.findIndex((g) => g.asserts.length > 0);
    if (firstNonEmpty >= 0) this.nav.focus = firstNonEmpty;
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

  // ── Hooks (override SectionedPanel defaults) ──────────────────────
  // `render`/`bodyLines`/`renderUnboundedBody`/`renderSectionHeader`/
  // `renderInactiveSectionHeader`/`moveFocus` are all inherited from
  // `SectionedPanel` — the two panels share one composition path.  These
  // hooks supply the panel-specific branches that `bodyLines` delegates to.
  protected emptyBodyLines(_width: number): string[] {
    // No asserts at all (fresh install or broken config).  The Presets
    // section is still rendered (header shown even when empty — the home
    // for `p`/`n`) so the user has somewhere to land; the message guides them.
    return [
      ...this.renderHeaderLines(),
      this.renderSectionHeader(0),
      this.theme.fg(
        "dim",
        "No asserts defined! Press " +
          this.theme.fg("accent", "i") + " to install or " +
          this.theme.fg("accent", "n") + " for a new preset.",
      ),
    ];
  }

  protected modeBodyLines(_width: number): string[] | null {
    if (!this.confirm) return null;
    return [...this.renderHeaderLines(), "", `  Remove "${this.confirm.name}"?`];
  }

  protected detailBlockFor(a: Assert | undefined, width: number): string[] {
    if (!a) return [];
    return [
      ...this.readonlyDetailLines(a),
      ...this.orphanedDetailLines(a),
      ...this.danglingDetailLines(a),
      ...renderAssertDetail(this.theme, width, a),
    ];
  }

  protected renderHeaderLines(): string[] {
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
  /** Compatibility fallback keeps lightweight panel consumers working. */
  private activeFor(a: Assert): boolean {
    const modern = this.state as AssertsState & { isActive?: (entry: Assert) => boolean };
    return modern.isActive ? modern.isActive(a) : this.state.active.has(a.name);
  }

  /** The plain row label: `name` plus the optional ` (default)` tag. */
  private plainLabel(a: Assert): string {
    return a.default ? `${a.name} (default)` : a.name;
  }

  /**
   * Styled status string for an assert row.  Three states:
   *
   *  - individually active → `enabled` (accent)
   *  - covered by an active preset but not individually active →
   *    `active · via {preset}` where `active` is dim and `via {preset}`
   *    is accent
   *  - disabled → `disabled` (dim)
   *
   * An assert active both individually and via a preset shows just `enabled`
   * (the `via` is redundant — it runs either way).  Multiple covering presets
   * collapse to `via {n} presets`.
   */
  private renderStatus(a: Assert): string {
    if (this.activeFor(a)) {
      return this.theme.fg("accent", "enabled");
    }
    const via = this.coverage.get(`${a.source}\x00${a.name}`);
    if (via && via.length > 0) {
      const label = via.length === 1
        ? `via ${via[0]}`
        : `via ${via.length} presets`;
      return (
        this.theme.fg("dim", "active") +
        this.theme.fg("dim", " · ") +
        this.theme.fg("accent", label)
      );
    }
    return this.theme.fg("dim", "disabled");
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

  /**
   * Adds the `p` jump key for the Presets section (always shown, even when
   * focused, so the jump target is discoverable from any section) on top of
   * the base's shared `Tab`/`Shift+Tab` cycle hints.
   */
  protected sectionHeaderKeys(index: number): string[] {
    // `p` jumps to the Presets section (always index 0); the base adds the
    // shared `Tab`/`Shift+Tab` cycle hints on the sections a cycle lands on.
    const keys = super.sectionHeaderKeys(index);
    if (this.groups[index].source === PRESETS_SOURCE) keys.unshift("p");
    return keys;
  }

  protected renderSection(
    width: number,
    group: Group,
    focused: boolean,
    selectedIndex: number,
    start = 0,
    end = group.asserts.length,
  ): string[] {
    if (!focused) {
      // Dimmed static listing.
      const { badgeFor, badgeWidth, maxLabelWidth } = this.badgeLayout(group);
      const lines: string[] = [];
      const muted = (s: string) => this.theme.fg("muted", s);
      const accent = (s: string) => this.theme.fg("accent", s);
      for (const a of group.asserts) {
        const badge = badgeFor(a);
        const labelW = this.plainLabel(a).length + badgeWidth(a);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const status = this.renderStatus(a);
        lines.push(
          `   ${badge}${this.renderLabel(a, muted, accent, padding)}  ${status}`,
        );
      }
      return lines;
    }

    // Active section: delegate to the shared renderDetailList so the row
    // layout, "> " highlight prefix, and inline shell/when (or asserts:)
    // detail block are identical to the install wizard's assert-entry
    // picker.  We pass our own [start, end) window (the panel manages
    // per-section scrolling and renders its own scroll indicator outside
    // the section).
    //
    // Badges render OUTSIDE the accent wrap so their colours hold on the
    // selected row.  Left-to-right: `P ` (preset, accent), `§ ` (dangling,
    // warning), `⚠ ` (orphaned, warning).  `§`+`⚠` co-occur; `P` is always
    // on presets.  The width of every present badge is reserved in
    // `maxLabelWidth` so the status column stays aligned across mixed badge
    // sets (a `P § ⚠` preset and a bare `⚠` assert line up).
    const theme = this.theme;
    const { badgeFor, badgeWidth, maxLabelWidth } = this.badgeLayout(group);

    return renderDetailList(theme, width, {
      items: group.asserts,
      selectedIndex,
      window: [start, end],
      showScrollIndicator: false,
      highlightQuery: this.searchActive ? this.query : undefined,
      renderRow: (a, selected) => {
        const badge = badgeFor(a);
        const labelW = this.plainLabel(a).length + badgeWidth(a);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const base = selected
          ? (s: string) => theme.fg("accent", s)
          : (s: string) => s;
        const highlight = selected
          ? (s: string) => theme.fg("accent", theme.underline(s))
          : (s: string) => theme.fg("accent", s);
        const labelText = this.renderLabel(a, base, highlight, padding);
        const valueText = this.renderStatus(a);
        return `${badge}${labelText}  ${valueText}`;
      },
      detailFor: (a) =>
        isPreset(a) ? { preset: a.preset } : { shell: a.shell, when: a.when },
      detailPrefix: (a) => [
        ...this.readonlyDetailLines(a),
        ...this.orphanedDetailLines(a),
        ...this.danglingDetailLines(a),
      ],
    });
  }

  /**
   * Per-render badge geometry for one section: the styled badge string, its
   * visible width, and the section-wide `maxLabelWidth` (label + badges) so
   * the status column aligns across mixed badge sets.  The three badge
   * strings are built once and their widths cached — `visibleWidth` would
   * otherwise re-measure the ANSI-wrapped string per row.
   */
  private badgeLayout(group: Group): {
    badgeFor: (a: Assert) => string;
    badgeWidth: (a: Assert) => number;
    maxLabelWidth: number;
  } {
    const theme = this.theme;
    // `❄` marks non-local presets as read-only (only local presets are
    // editable via `e`).  Local presets carry no badge.  `§` (dangling) and
    // `⚠` (orphaned) still apply to presets of any source.
    const LOCK_BADGE = theme.fg("dim", "❄ ");
    const DANGLE_BADGE = theme.fg("warning", "§ ");
    const ORPHAN_BADGE = theme.fg("warning", "⚠ ");
    const LOCK_W = visibleWidth(LOCK_BADGE);
    const DANGLE_W = visibleWidth(DANGLE_BADGE);
    const ORPHAN_W = visibleWidth(ORPHAN_BADGE);
    const isLocked = (a: Assert): boolean => isPreset(a) && a.source !== "local";
    const badgeFor = (a: Assert): string => {
      let b = "";
      if (isLocked(a)) b += LOCK_BADGE;
      if (this.isDangling(a)) b += DANGLE_BADGE;
      if (this.isOrphaned(a)) b += ORPHAN_BADGE;
      return b;
    };
    const badgeWidth = (a: Assert): number =>
      (isLocked(a) ? LOCK_W : 0) +
      (this.isDangling(a) ? DANGLE_W : 0) +
      (this.isOrphaned(a) ? ORPHAN_W : 0);
    const maxLabelWidth = Math.max(
      0,
      ...group.asserts.map((a) => this.plainLabel(a).length + badgeWidth(a)),
    );
    return { badgeFor, badgeWidth, maxLabelWidth };
  }

  /**
   * Contextual warning line shown in the detail block under a focused
   * orphaned assert — explains what the `⚠` badge means and how to act on
   * it.  Returns `[]` for non-orphaned asserts so the detail block is
   * unchanged.
   */
  private orphanedDetailLines(a: Assert): string[] {
    if (!this.isOrphaned(a)) return [];
    return [
      "    " +
        this.theme.fg("warning", "⚠ ") +
        this.theme.fg("dim", "removed from source repo — press r to uninstall"),
    ];
  }

  /**
   * Contextual note shown in the detail block under a focused non-local
   * preset — explains what the `❄` badge means: only local presets are
   * editable via `e`; a repo preset is read-only.  Guides the user to the
   * workaround (copy via `n`) since fork-on-edit was removed.  Returns `[]`
   * for local presets and non-presets so the detail block is unchanged.
   */
  private readonlyDetailLines(a: Assert): string[] {
    if (!isPreset(a) || a.source === "local") return [];
    return [
      "    " +
        this.theme.fg("dim", "❄ ") +
        this.theme.fg("dim", "non-editable — copy via n to customize"),
    ];
  }

  /**
   * Contextual warning line shown in the detail block under a focused preset
   * with one or more dangling refs (`§` badge) — lists the refs that don't
   * resolve to an installed shell assert.  Returns `[]` for non-presets and
   * for presets whose every ref resolves, so the detail block is unchanged.
   */
  private danglingDetailLines(a: Assert): string[] {
    const refs = this.danglingRefs(a);
    if (refs.length === 0) return [];
    const label = refs.length === 1 ? "dangling ref" : "dangling refs";
    return [
      "    " +
        this.theme.fg("warning", "§ ") +
        this.theme.fg("dim", `${label}: ${refs.join(", ")}`),
    ];
  }

  /** The one hint source — confirm-aware so `render`'s tail always emits the right hint. */
  protected hintLine(width?: number): string[] {
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

    const items: HintItem[] = [
      HINT_ENTER_ENABLE,
      HINT_T_TOGGLE_DEFAULT,
    ];
    if (this.state.active.size > 0) {
      items.push(HINT_D_DISABLE_ALL);
    }
    items.push(HINT_R_REMOVE);
    items.push(HINT_I_INSTALL_ASSERTS);
    items.push(HINT_N_NEW_PRESET);
    // `e` edits presets only — advertise it iff the focused row is a preset,
    // so the hint never teases an action that doesn't apply to a shell
    // assert.  A non-local preset is read-only (`❄`): the `e` action is
    // shown crossed out (disabled) so the user sees it exists but doesn't
    // apply here, and the detail line explains why.  Pressing `e` anyway
    // still notifies (defensive).
    const focused = this.groups[this.nav.focusedSection]?.asserts[this.nav.focusedIndex];
    if (focused && isPreset(focused)) {
      items.push(
        focused.source === "local"
          ? HINT_E_EDIT_PRESET
          : ["e", "Edit preset", true],
      );
    }
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

  /**
   * The extension context for the current `handleInput` call.  Set at the
   * top of `handleInput` so the shared `toggleFocused()` (parameterless, in
   * the base) can reach `state.updateStatus(ctx)` without threading `ctx`
   * through the shared input path.
   */
  private _ctx!: ExtensionContext;

  setTheme(theme: Theme): void {
    this._theme = theme;
  }

  protected get theme(): Theme {
    return this._theme;
  }

  // ── Input ──────────────────────────────────────────────────────────
  /**
   * Handle a key.  Returns a string when the panel wants the dialog to
   * close (cancel / install / reload), or `undefined` to keep going.
   */
  handleInput(data: string, ctx: ExtensionContext): PanelAction | undefined {
    this._ctx = ctx;

    // ── Confirmation mode ──
    if (this.confirm) {
      if (matchesKey(data, "y")) {
        const { name, source, path } = this.confirm;
        if (!path) {
          ctx.ui.notify(`pi-assert: cannot locate "${name}" on disk`, "error");
          this.confirm = null;
          return undefined;
        }
        removeRuleAt(path, source, name);
        const selected = this.state.asserts.find((a) =>
          a.source === source && a.name === name && a.path === path,
        );
        if (selected) this.state.disable(selected);
        this._coverage = null;
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

    // ── Search mode (shared with every sectioned panel) ──
    // Whitelist navigators + Enter + Esc + Backspace; everything else (incl.
    // Space and `r`/`t`/`d`/`i`) feeds the query.  `r`/`t`/`d`/`i` are
    // unreachable until `Esc` exits search.  Owned by `SectionedPanel`.
    if (this.handleSearchInput(data)) return undefined;

    // ── Panel-specific hotkeys (asserts-panel-only) ──
    // `/` (search), Enter (toggle), Tab/Shift+Tab, arrows are shared and live
    // in `handleNavInput` at the bottom; `i`/`n`/`p`/Esc are asserts-only.
    if (matchesKey(data, "i")) {
      if (this.state.broken) {
        ctx.ui.notify("pi-assert: fix asserts.json before installing rules.", "error");
        return undefined;
      }
      return "install";
    }
    // `n` opens the new-preset dialog (handled by the command loop).  In
    // confirm mode `n` cancels (confirm is checked first); in search `n`
    // feeds the query (search is checked first) — so this branch is only
    // reached in normal mode.
    if (matchesKey(data, "n")) {
      if (this.state.broken) {
        ctx.ui.notify("pi-assert: fix asserts.json before creating a preset.", "error");
        return undefined;
      }
      return "create-preset";
    }
    // `p` jumps to the always-first Presets section (row 0, or the header
    // when empty).  Presets is always index 0 (see `groupBySource`).
    if (matchesKey(data, "p")) {
      this.nav.focus = 0;
      this.nav.selection[0] = 0;
      return undefined;
    }
    if (matchesKey(data, Key.escape)) return "cancel";

    const focused = this.groups[this.nav.focusedSection];
    if (!focused) return undefined;

    // ── d: disable all active asserts (no-op when none active) ──
    if (matchesKey(data, "d")) {
      if (this.state.active.size === 0) return undefined;
      this.state.disableAll();
      this._coverage = null;
      this.state.persist();
      this.state.updateStatus(ctx);
      return undefined;
    }

    // ── r: remove selected assert ──
    // Write-back uses `selected.source`/`selected.path`, not `focused.source`:
    // the Presets group is synthetic (label "Presets"), so `focused.source` is
    // the group label, not the preset's real section.  This is a one-time M3
    // switch that applies to all entry types (hoisting makes `focused.source`
    // wrong in general).
    if (matchesKey(data, "r")) {
      const selected = focused.asserts[this.nav.focusedIndex];
      if (selected) {
        this.confirm = { name: selected.name, source: selected.source, path: selected.path };
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
        setAssertDefault(selected.path, selected.source, selected.name, next);

        // Mirror the new value to the in-memory `Assert` so the next render
        // shows the (default) tag.  The panel's `group.asserts` array shares
        // object references with `state.asserts` (both were built from the
        // same `loadAsserts` result), so mutating the live entry mutates
        // both views.  Reloading here would create new objects and break
        // that link.
        const live = this.state.asserts.find(
          (a) => a.source === selected.source && a.name === selected.name,
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

    // ── e: edit focused preset (local presets only) ──
    // Returns an `edit-preset` action carrying the focused preset; the command
    // loop runs the two-step editor (`description` → `asserts` panel, the same
    // sectioned panel as `/asserts`: Tab/Shift+Tab, `Enter` toggles membership,
    // `Esc` commits + back) and writes the edit in place via `editPresetRule`.
    // Only local presets are editable.  A non-local preset is read-only (`❄`):
    // the hint line shows `e Edit preset` crossed out and the detail block
    // shows `❄ non-editable — copy via n to customize`, so the state is
    // visible at a glance.  Pressing `e` anyway notifies (defensive).  An
    // `Esc` with no changes is a no-op (see `editPreset`).  Non-presets
    // notify instead of acting.
    if (matchesKey(data, "e")) {
      const selected = focused.asserts[this.nav.focusedIndex];
      if (!selected) return undefined;
      if (!isPreset(selected)) {
        ctx.ui.notify(
          "pi-assert: e edits presets only — select a preset first.",
          "info",
        );
        return undefined;
      }
      if (selected.source !== "local") {
        ctx.ui.notify(
          "pi-assert: only local presets are editable — this preset is read-only (❄).",
          "info",
        );
        return undefined;
      }
      return { type: "edit-preset", preset: selected };
    }

    // ── Shared navigation (`/` search, Enter toggle, Tab/Shift+Tab cycle,
    // arrows) — identical to the preset editor's assert picker. ──
    if (this.handleNavInput(data)) return undefined;

    return undefined;
  }

  // ── Shared input hook ───────────────────────────────────────────────
  /** Toggle the active state of the currently focused assert. */
  protected toggleFocused(): void {
    const focused = this.groups[this.nav.focusedSection];
    const selected = focused?.asserts[this.nav.focusedIndex];
    if (!selected) return;
    const isModern = typeof (this.state as { isActive?: unknown }).isActive === "function";
    // Older lightweight consumers expose name-based mutators; production
    // state exposes isActive and stores canonical source-qualified keys.
    if (this.activeFor(selected)) this.state.disable(isModern ? selected : selected.name);
    else this.state.enable(isModern ? selected : selected.name);
    this._coverage = null;
    this.state.persist();
    this.state.updateStatus(this._ctx);
  }
}

// ---------------------------------------------------------------------------
// createLocalPreset — `n` new local preset.  Prompts for a name, warns (does
// not silently overwrite) if the name already exists in the local section,
// then installs an empty preset and lets the command loop reload.  `default`
// is dropped (passed as `undefined` so `cleanEntry` omits it, matching
// "omit when false" / `setAssertDefault` deleting the key).
// ---------------------------------------------------------------------------
export async function createLocalPreset(
  ctx: ExtensionContext,
  state: AssertsState,
): Promise<void> {
  const name = await textInputDialog(ctx, {
    title: "New preset",
    label: "Preset name:",
    hint: [HINT_ENTER_CONFIRM, HINT_ESC_CANCEL],
  });
  if (!name) return; // cancelled

  // Warn (don't silently overwrite) if the name already exists locally —
  // mirrors `installRule`'s `overwritten` return, but for a *create* we abort
  // rather than clobber so the user removes the existing entry first.
  if (state.asserts.some((a) => a.source === "local" && a.name === name)) {
    ctx.ui.notify(
      `pi-assert: "${name}" already exists locally — remove it first.`,
      "warning",
    );
    return;
  }

  try {
    installRule(ctx.cwd, "local", name, {
      description: "",
      preset: [],
      default: undefined,
    });
  } catch (err) {
    ctx.ui.notify(`pi-assert: failed to create preset — ${String(err)}`, "error");
    return;
  }
  ctx.ui.notify(`pi-assert: created preset "${name}".`, "info");
}

// ---------------------------------------------------------------------------
// editPreset — `e` edit focused preset.  Two-step editor (Q18: lean two-step
// to keep `dialogShell` single-purpose): `description` (text) → `asserts`
// panel (the same sectioned panel as `/asserts`: Tab/Shift+Tab to navigate,
// `Enter` to toggle membership, `Esc` to commit + go back).
//
// Local-only (the `e` handler gates on `source === "local"`; non-local
// presets are read-only `❄` and never reach here).  Writes `preset` +
// `description` (+ preserved `default`) in place via `editPresetRule`.
// Forking a repo preset to local on edit was removed — to customize a repo
// preset, copy its content into a new local preset via `n`.
// ---------------------------------------------------------------------------
async function editPreset(
  ctx: ExtensionContext,
  state: AssertsState,
  preset: PresetAssert,
): Promise<void> {
  // Step 1: description (text), seeded with the current description.
  const description = await textInputDialog(ctx, {
    title: "Edit preset",
    label: "Description:",
    initial: preset.description,
    hint: [HINT_ENTER_CONFIRM, HINT_ESC_CANCEL],
  });
  if (description === null) return; // cancelled — no data loss

  // Step 2: asserts — the same sectioned panel as `/asserts` (sections by
  // source, fzf-style search, Tab/Shift+Tab navigation).  Only shell asserts
  // are offered: nested presets are dangling for v1, so a ref to a preset is
  // excluded from the picker.  `Enter` toggles membership (`✓`), `Esc`
  // commits + goes back.
  const result = await runPresetEditor(ctx, state, preset, description);

  // No-op guard: skip the write when nothing actually changed, so opening
  // the editor and pressing Esc with no edits doesn't rewrite the file.
  // Membership is compared as a set — the editor can't reorder refs, so a
  // set-equal result means the user toggled nothing.
  const sameDesc = description === preset.description;
  const sameMembers =
    result.value.length === preset.preset.length &&
    result.value.every((r) => preset.preset.includes(r));
  if (sameDesc && sameMembers) return;

  // Write preset + description (+ preserved default) in place to the owning
  // file's `local` section.
  try {
    editPresetRule(
      preset.path ?? projectFilePath(ctx.cwd),
      preset.name,
      description,
      result.value,
    );
  } catch (err) {
    ctx.ui.notify(`pi-assert: failed to edit preset — ${String(err)}`, "error");
    return;
  }
  ctx.ui.notify(`pi-assert: edited preset "${preset.name}".`, "info");
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
        const validKeys = new Set(state.asserts.map((a) => state.keyOf(a)));
        for (const key of Array.from(state.active)) {
          if (!validKeys.has(key)) state.disable(key);
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
        if (action === "create-preset") {
          await createLocalPreset(ctx, state);
          continue;
        }
        if (action !== null && typeof action === "object" &&
          action.type === "edit-preset") {
          await editPreset(ctx, state, action.preset);
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
