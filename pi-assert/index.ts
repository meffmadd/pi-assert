import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

import {
  loadAsserts,
  matchFilter,
  buildEnv,
  evaluateShell,
  type Assert,
  type ShellResult,
} from "./engine.js";

// ---------------------------------------------------------------------------
// Persistent state shape
// ---------------------------------------------------------------------------
interface AssertsState {
  activeAsserts: string[];
}

export default function (pi: ExtensionAPI) {
  let asserts: Assert[] = [];
  let activeAsserts: Set<string> = new Set();

  // -----------------------------------------------------------------------
  // Persistence helpers
  // -----------------------------------------------------------------------
  function persistState() {
    pi.appendEntry<AssertsState>("pi-assert-config", {
      activeAsserts: Array.from(activeAsserts),
    });
  }

  function restoreFromBranch(ctx: ExtensionContext) {
    const branchEntries = ctx.sessionManager.getBranch();
    let saved: string[] | undefined;

    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "pi-assert-config") {
        const data = entry.data as AssertsState | undefined;
        if (data?.activeAsserts) {
          saved = data.activeAsserts;
        }
      }
    }

    if (saved) {
      // Restore saved selection (filter to only asserts that still exist)
      const allNames = new Set(asserts.map((a) => a.name));
      activeAsserts = new Set(saved.filter((n) => allNames.has(n)));
    } else {
      // No saved state — enable only asserts with default: true
      activeAsserts = new Set(asserts.filter((a) => a.default).map((a) => a.name));
    }
  }

  // -----------------------------------------------------------------------
  // Load asserts on session start
  // -----------------------------------------------------------------------
  pi.on("session_start", (_event, ctx) => {
    asserts = loadAsserts(ctx.cwd);
    restoreFromBranch(ctx);

    if (asserts.length > 0) {
      ctx.ui.notify(
        `pi-assert: ${asserts.length} assert${asserts.length === 1 ? "" : "s"} loaded (${activeAsserts.size} active)`,
        "info",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Restore state when navigating the session tree
  // -----------------------------------------------------------------------
  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  // -----------------------------------------------------------------------
  // /asserts command — toggle asserts on/off via popup
  // -----------------------------------------------------------------------
  pi.registerCommand("asserts", {
    description: "Activate / deactivate asserts",
    handler: async (_args, ctx) => {
      // Refresh assert list in case reloaded without restart
      asserts = loadAsserts(ctx.cwd);

      if (asserts.length === 0) {
        ctx.ui.notify("pi-assert: No asserts defined in .pi/asserts.json", "info");
        return;
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const items: SettingItem[] = asserts.map((a) => ({
          id: a.name,
          label: a.name,
          currentValue: activeAsserts.has(a.name) ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        }));

        const container = new Container();

        // Header
        container.addChild(
          new (class {
            render(_width: number) {
              return [
                theme.fg("accent", theme.bold("Asserts")),
                theme.fg("muted", `${activeAsserts.size}/${asserts.length} active`),
                "",
              ];
            }
            invalidate() {}
          })(),
        );

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 3, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            if (newValue === "enabled") {
              activeAsserts.add(id);
            } else {
              activeAsserts.delete(id);
            }
            persistState();
            // Update the header
            tui.requestRender();
          },
          () => done(undefined),
        );

        container.addChild(settingsList);

        const component = {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };

        return component;
      });
    },
  });

  // -----------------------------------------------------------------------
  // Intercept tool calls
  // -----------------------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    for (const assert of asserts) {
      // Only handle tool_call hook for now (future: tool_result, etc.)
      if (assert.hook !== "tool_call") continue;

      // Skip if assert is not active
      if (!activeAsserts.has(assert.name)) continue;

      // Skip if filter doesn't match
      if (!matchFilter(assert.filter, event)) continue;

      // Build env and run the shell command
      const env = buildEnv(event, ctx);
      const result: ShellResult = await evaluateShell(assert.shell, env, ctx.signal);

      if (!result.passed) {
        const reason = `pi-assert: assertion "${assert.name}" rejected ${event.toolName} — \`${assert.shell}\``;

        if (ctx.hasUI) {
          ctx.ui.notify(reason, "error");
        }

        return { block: true, reason };
      }
    }
  });
}
