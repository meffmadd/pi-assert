import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Key,
  SelectList,
  type SelectItem,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";

import {
  fetchRuleFiles,
  fetchRuleFile,
  installRule,
  type RuleEntries,
} from "./install.js";
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
  // Status bar
  // -----------------------------------------------------------------------
  function updateStatus(ctx: ExtensionContext) {
    if (asserts.length === 0) {
      ctx.ui.setStatus("pi-assert", undefined);
      return;
    }
    const theme = ctx.ui.theme;
    const color = activeAsserts.size > 0 ? "accent" : "dim";
    ctx.ui.setStatus(
      "pi-assert",
      theme.fg(color, `asserts: ${activeAsserts.size}/${asserts.length}`),
    );
  }

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

    updateStatus(ctx);
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
    updateStatus(ctx);
  });

  // -----------------------------------------------------------------------
  // /asserts install — browse and install rules from GitHub
  // -----------------------------------------------------------------------
  async function installFlow(ctx: ExtensionContext): Promise<void> {
    const repo = "meffmadd/pi-assert-rules";

    // ── Step 1: fetch and pick a rule file ──
    let files: Awaited<ReturnType<typeof fetchRuleFiles>>;
    try {
      files = await fetchRuleFiles(repo);
    } catch (err) {
      ctx.ui.notify(
        `pi-assert: failed to fetch rule files — ${String(err)}`,
        "error",
      );
      return;
    }

    if (files.length === 0) {
      ctx.ui.notify("No rule files found in pi-assert-rules.", "info");
      return;
    }

    const selectedFile = await ctx.ui.custom<string | null>(
      (tui, theme, _kb, done) => {
        const items: SelectItem[] = files.map((f) => ({
          value: f.path,
          label: f.name,
        }));

        const container = new Container();
        container.addChild(
          new DynamicBorder((s: string) => theme.fg("accent", s)),
        );
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold("Rule Files (pi-assert-rules)")),
            1,
            0,
          ),
        );

        const list = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);

        container.addChild(
          new Text(
            theme.fg("dim", "↑↓ navigate • enter open • esc cancel"),
            1,
            0,
          ),
        );
        container.addChild(
          new DynamicBorder((s: string) => theme.fg("accent", s)),
        );

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );

    if (!selectedFile) return; // user cancelled

    // ── Step 2: fetch and parse the file ──
    let entries: RuleEntries;
    try {
      entries = await fetchRuleFile(repo, selectedFile);
    } catch (err) {
      ctx.ui.notify(
        `pi-assert: failed to load rule file — ${String(err)}`,
        "error",
      );
      return;
    }

    const entryNames = Object.keys(entries);
    if (entryNames.length === 0) {
      ctx.ui.notify("No valid asserts in this file.", "info");
      return installFlow(ctx); // back to file picker
    }

    // ── Step 3: pick an assert to install ──
    const selectedName = await ctx.ui.custom<string | null>(
      (tui, theme, _kb, done) => {
        const items: SelectItem[] = entryNames.map((name) => {
          const e = entries[name]!;
          return {
            value: name,
            label: name,
            description: e.description,
          };
        });

        const fileName = selectedFile
          .replace(/^rules\//, "")
          .replace(/\.json$/, "");

        const container = new Container();
        container.addChild(
          new DynamicBorder((s: string) => theme.fg("accent", s)),
        );
        container.addChild(
          new Text(theme.fg("accent", theme.bold(fileName)), 1, 0),
        );

        const list = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);

        container.addChild(
          new Text(
            theme.fg("dim", "↑↓ navigate • enter install • esc back"),
            1,
            0,
          ),
        );
        container.addChild(
          new DynamicBorder((s: string) => theme.fg("accent", s)),
        );

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );

    if (!selectedName) return installFlow(ctx); // esc → back to file picker

    // ── Step 4: install ──
    const entry = entries[selectedName]!;
    try {
      installRule(ctx.cwd, selectedName, entry);

      // Reload in-memory asserts so the new rule appears in /asserts
      asserts = loadAsserts(ctx.cwd);
      restoreFromBranch(ctx);
      updateStatus(ctx);

      ctx.ui.notify(
        `pi-assert: installed "${selectedName}". Use /asserts to enable it.`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(
        `pi-assert: failed to install "${selectedName}" — ${String(err)}`,
        "error",
      );
      return;
    }

    // ── Step 5: back to file picker (install more from same file) ──
    return installFlow(ctx);
  }

  // -----------------------------------------------------------------------
  // /asserts command — toggle asserts on/off or install from repo
  // -----------------------------------------------------------------------
  pi.registerCommand("asserts", {
    description: "Activate / deactivate asserts",
    handler: async (_args, ctx) => {
      // Loop: show toggle UI; if user requests install, run it and show
      // the toggle UI again so the new rule appears immediately.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        asserts = loadAsserts(ctx.cwd);

        const action = await ctx.ui.custom<string | null>(
          (tui, theme, _kb, done) => {
            const container = new Container();

            // ── Asserts header ──
            container.addChild(
              new (class {
                render(_width: number) {
                  return [
                    theme.fg("accent", theme.bold("Asserts")),
                    theme.fg(
                      "muted",
                      `${activeAsserts.size}/${asserts.length} active`,
                    ),
                    "",
                  ];
                }
                invalidate() {}
              })(),
            );

            // ── Settings list (or empty-state) ──
            interface ListHandle {
              handleInput(data: string): void;
              invalidate(): void;
              render(width: number): string[];
            }
            let listHandle: ListHandle | undefined;
            if (asserts.length > 0) {
              const items: SettingItem[] = asserts.map((a) => ({
                id: a.name,
                label: a.name,
                currentValue: activeAsserts.has(a.name)
                  ? "enabled"
                  : "disabled",
                values: ["enabled", "disabled"],
              }));

              const rawList = new SettingsList(
                items,
                Math.min(items.length + 5, 15),
                {
                  ...getSettingsListTheme(),
                  selectedPrefix: (t: string) =>
                    theme.fg("accent", "> "),
                  selectedText: (t: string) =>
                    theme.fg("accent", t),
                },
                (id, newValue) => {
                  if (newValue === "enabled") {
                    activeAsserts.add(id);
                  } else {
                    activeAsserts.delete(id);
                  }
                  persistState();
                  updateStatus(ctx);
                  tui.requestRender();
                },
                () => done(null),
              );

              // Augment SettingsList's built-in hint with install option.
              const wrapped = new (class {
                render(width: number) {
                  const lines = rawList.render(width);
                  if (lines.length >= 2) {
                    const last = lines[lines.length - 1];
                    const prev = lines[lines.length - 2];
                    if (
                      prev === "" &&
                      last.includes("Enter/Space to change")
                    ) {
                      // Inject install hint; re-dim the trailing segment
                      // since theme.fg("dim", ...) emits a reset.
                      const tail = theme.fg("dim", " · Esc to cancel");
                      const augmented = last.replace(
                        "· Esc to cancel",
                        `· ${theme.fg("accent", "i")} ${theme.fg("dim", "Install asserts")}${tail}`,
                      );
                      lines[lines.length - 1] = augmented;
                    }
                  }
                  return lines;
                }
                invalidate() {
                  rawList.invalidate();
                }
                handleInput(data: string) {
                  rawList.handleInput(data);
                }
              })();
              listHandle = wrapped;
              container.addChild(wrapped);
            } else {
              container.addChild(
                new Text(
                  theme.fg("dim", "No asserts defined."),
                  1,
                  0,
                ),
              );
            }

            return {
              render(width: number) {
                return container.render(width);
              },
              invalidate() {
                container.invalidate();
              },
              handleInput(data: string) {
                if (matchesKey(data, "i")) {
                  done("install");
                  return;
                }
                if (matchesKey(data, Key.escape)) {
                  done(null);
                  return;
                }
                listHandle?.handleInput?.(data);
                tui.requestRender();
              },
            };
          },
          {},
        );

        if (action !== "install") break;

        // Run install, then loop back to show the updated toggle UI
        await installFlow(ctx);
      }
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

      // Build env shared by both `when` and `shell`
      const env = buildEnv(event, ctx);

      // Run precondition if present — skip assert when it doesn't pass
      if (assert.when) {
        const precondition: ShellResult = await evaluateShell(assert.when, env, ctx.signal);
        if (!precondition.passed) continue;
      }

      // Run the main shell command
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
