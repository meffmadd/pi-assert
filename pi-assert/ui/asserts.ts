import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Key,
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import type { Assert } from "../engine.js";
import { removeRule, setAssertDefault } from "../installer.js";
import { SectionNavigator } from "./components.js";
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

  constructor(private state: AssertsState) {
    this.groups = groupBySource(state.asserts);
    this.nav = new SectionNavigator<Assert>(
      this.groups.map((g) => ({ items: g.asserts })),
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  render(width: number): string[] {
    if (this.groups.length === 0) {
      return [this.theme.fg("dim", "No asserts defined.")];
    }

    if (this.confirm) {
      return [
        "",
        `  Remove "${this.confirm.name}"? y/n`,
        "",
      ];
    }

    const lines: string[] = [];
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i];
      const isFocused = i === this.nav.focusedSection;
      const headerColor = isFocused ? "accent" : "muted";
      const header = g.source === "local" ? "Local" : g.source;
      lines.push(`  ${this.theme.fg(headerColor, header)}`);

      lines.push(
        ...this.renderSection(width, g, isFocused, this.nav.focusedIndex),
      );
      if (i < this.groups.length - 1) lines.push("");
    }

    lines.push("", this.hintLine());
    return lines;
  }

  // ── Render helpers ─────────────────────────────────────────────────
  private renderSection(
    _width: number,
    group: Group,
    focused: boolean,
    _selectedIndex: number,
  ): string[] {
    if (!focused) {
      // Dimmed static listing
      const lines: string[] = [];
      for (const a of group.asserts) {
        const status = this.state.active.has(a.name)
          ? this.theme.fg("muted", "enabled")
          : this.theme.fg("dim", "disabled");
        const tag = a.default ? this.theme.fg("dim", " (default)") : "";
        lines.push(`   ${this.theme.fg("muted", a.name)}${tag}  ${status}`);
      }
      return lines;
    }

    // Active section: render via SettingsList and strip its built-in hint
    const items: SettingItem[] = group.asserts.map((a) => ({
      id: a.name,
      label: a.default ? `${a.name} (default)` : a.name,
      currentValue: this.state.active.has(a.name) ? "enabled" : "disabled",
      values: ["enabled", "disabled"],
    }));

    // The panel drives all key handling itself (see `handleInput`), so the
    // SettingsList here is purely a renderer.  The `onChange` and
    // `onCancel` callbacks are never invoked by us, but the constructor
    // requires them — provide no-op stubs.
    const settingsTheme: SettingsListTheme = {
      label: (text, selected) =>
        selected ? this.theme.fg("accent", text) : text,
      value: (text, selected) =>
        selected
          ? this.theme.fg("accent", text)
          : this.theme.fg("dim", text),
      description: (text) => this.theme.fg("muted", text),
      cursor: this.theme.fg("accent", "> "),
      hint: (text) => this.theme.fg("dim", text),
    };

    const sl = new SettingsList(
      items,
      Math.min(items.length + 3, 10),
      settingsTheme,
      // onChange — never reached (the panel toggles via its own handleInput)
      (_id, _newValue) => {},
      // onCancel — never reached (Esc is handled at the dialog level)
      () => {},
    );

    const listLines = sl.render(_width);
    // Strip the SettingsList's built-in hint (last 2 lines: blank + "Enter/Space to change")
    if (
      listLines.length >= 2 &&
      listLines[listLines.length - 2] === "" &&
      listLines[listLines.length - 1]?.includes("Enter/Space to change")
    ) {
      listLines.length -= 2;
    }
    return listLines;
  }

  private hintLine(): string {
    const dim = (s: string) => this.theme.fg("dim", s);
    const acc = (s: string) => this.theme.fg("accent", s);
    const focused = this.groups[this.nav.focusedSection];
    const removeHint =
      focused && focused.source !== "local" ? acc("d") + dim(" Remove · ") : "";
    return (
      dim("  Enter/Space enable · ") +
      acc("t") + dim(" Toggle default · ") +
      removeHint +
      acc("i") + dim(" Install asserts · Esc to cancel")
    );
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

    // ── d: remove selected assert (non-local only) ──
    if (matchesKey(data, "d")) {
      if (focused.source === "local") {
        ctx.ui.notify("Local asserts cannot be removed from the UI", "info");
        return undefined;
      }
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
      }
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

            const header = new (class {
              render() {
                return [
                  theme.fg("accent", theme.bold("Asserts")),
                  theme.fg(
                    "muted",
                    `${state.active.size}/${state.asserts.length} active`,
                  ),
                  "",
                ];
              }
              invalidate() {}
            })();

            const container = new Container();
            container.addChild(header);
            container.addChild({
              render: (w: number) => panel.render(w),
              invalidate: () => {},
              handleInput: () => {},
            });

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
