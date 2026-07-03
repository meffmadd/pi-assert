import { type ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Key,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Assert } from "../engine.js";
import { fetchRepoEntries, removeRule, setAssertDefault } from "../installer.js";
import {
  HINT_D_DISABLE_ALL,
  HINT_ENTER_SPACE_ENABLE,
  HINT_ESC_CANCEL,
  HINT_I_INSTALL_ASSERTS,
  HINT_R_REMOVE,
  HINT_T_TOGGLE_DEFAULT,
  HINT_TAB_CYCLE_SECTION,
  OverlayBox,
  SectionNavigator,
  dialogOverlay,
  renderAssertDetail,
  renderDetailList,
  renderHintLine,
} from "./components.js";
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
    const available =
      terminalHeight - headerLines.length - 1 - hintLen;
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
      this.renderSectionHeader(activeGroup, true),
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
        this.renderSectionHeader(this.groups[focusedSection - 1], false),
        "",
        ...coreLines,
      ];
    }
    if (showNext) {
      coreLines = [
        ...coreLines,
        "",
        this.renderSectionHeader(this.groups[focusedSection + 1], false),
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
        const block = this.renderInactiveSectionHeader(this.groups[above]);
        if (block.length + 1 <= remaining) {
          lines = [...block, "", ...lines];
          remaining -= block.length + 1;
          above--;
          progressed = true;
        }
      }
      if (below < this.groups.length) {
        const block = this.renderInactiveSectionHeader(this.groups[below]);
        if (block.length + 1 <= remaining) {
          lines = [...lines, "", ...block];
          remaining -= block.length + 1;
          below++;
          progressed = true;
        }
      }
    }

    return [...headerLines, ...lines];
  }

  private renderUnboundedBody(width: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i];
      const isFocused = i === this.nav.focusedSection;
      lines.push(this.renderSectionHeader(g, isFocused));
      lines.push(...this.renderSection(width, g, isFocused, this.nav.focusedIndex));
      if (i < this.groups.length - 1) lines.push("");
    }
    return [...this.renderHeaderLines(), ...lines];
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
  private renderSectionHeader(group: Group, focused: boolean): string {
    const header = group.source === "local" ? "Local" : group.source;
    const color = focused ? "accent" : "muted";
    return `  ${this.theme.fg(color, header)}`;
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
          (a) =>
            (a.default ? `${a.name} (default)` : a.name).length +
            (isOrphaned(a) ? orphanW : 0),
        ),
      );
      const lines: string[] = [];
      for (const a of group.asserts) {
        const badge = isOrphaned(a)
          ? this.theme.fg("warning", "⚠ ")
          : "";
        const label = a.default ? `${a.name} (default)` : a.name;
        const labelW = label.length + (isOrphaned(a) ? orphanW : 0);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const status = this.state.active.has(a.name)
          ? this.theme.fg("muted", "enabled")
          : this.theme.fg("dim", "disabled");
        lines.push(
          `   ${badge}${this.theme.fg("muted", label + padding)}  ${status}`,
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
        (a) =>
          (a.default ? `${a.name} (default)` : a.name).length +
          (isOrphaned(a) ? orphanW : 0),
      ),
    );

    return renderDetailList(theme, width, {
      items: group.asserts,
      selectedIndex,
      window: [start, end],
      showScrollIndicator: false,
      renderRow: (a, selected) => {
        const badge = orphanBadge(a);
        const label = a.default ? `${a.name} (default)` : a.name;
        const status = active.has(a.name) ? "enabled" : "disabled";
        const labelW =
          label.length + (isOrphaned(a) ? orphanW : 0);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const labelText = selected
          ? theme.fg("accent", label + padding)
          : label + padding;
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

  private renderInactiveSectionHeader(group: Group): string[] {
    return [this.renderSectionHeader(group, false)];
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

    const items: [string, string][] = [
      HINT_ENTER_SPACE_ENABLE,
      HINT_T_TOGGLE_DEFAULT,
    ];
    if (this.state.active.size > 0) {
      items.push(HINT_D_DISABLE_ALL);
    }
    items.push(HINT_R_REMOVE);
    items.push(HINT_I_INSTALL_ASSERTS);
    if (this.groups.length > 1) {
      items.push(HINT_TAB_CYCLE_SECTION);
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

    // ── Global hotkeys ──
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

    // ── Enter / Space: toggle ──
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const selected = focused.asserts[this.nav.focusedIndex];
      if (selected) {
        if (this.state.active.has(selected.name)) {
          this.state.disable(selected.name);
        } else {
          this.state.enable(selected.name);
        }
        this.state.persist();
        this.state.updateStatus(ctx);
      }
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
    if (matchesKey(data, "up")) {
      if (this.nav.cross("up")) return undefined;
      this.nav.moveWithin("up");
      return undefined;
    }
    if (matchesKey(data, "down")) {
      if (this.nav.cross("down")) return undefined;
      this.nav.moveWithin("down");
      return undefined;
    }

    return undefined;
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
