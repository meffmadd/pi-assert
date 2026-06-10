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
  removeRule,
  addRepo,
  getInstalledRepos,
  type RuleEntries,
} from "./install.js";
import {
  loadAsserts,
  type Assert,
  type AgentEndEvent,
} from "./engine.js";
import { executeToolCallAsserts, executeAgentEndAsserts } from "./executor.js";

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
  // Install flow: repo picker → (add repo) → file picker → assert picker
  // -----------------------------------------------------------------------
  async function installFlow(ctx: ExtensionContext): Promise<void> {
    const DEFAULT_REPO =
      process.env.PI_ASSERT_DEFAULT_REPO ?? "meffmadd/pi-assert-rules";

    // ── Step 0: pick (or add) a repo ──
    let selectedRepo: string | null = null;

    while (!selectedRepo) {
      const repos = getInstalledRepos(ctx.cwd);

      // Build items: each repo + "Add repo..." at the bottom
      const items: SelectItem[] = [
        ...repos.map((r) => ({ value: r, label: r })),
        { value: "__add__", label: "Add repo…" },
      ];

      const action = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold("Repos")),
              1,
              0,
            ),
          );

          const list = new SelectList(
            items,
            Math.min(items.length, 12),
            {
              selectedPrefix: (t: string) => theme.fg("accent", t),
              selectedText: (t: string) => theme.fg("accent", t),
              description: (t: string) => theme.fg("muted", t),
              scrollInfo: (t: string) => theme.fg("dim", t),
              noMatch: (t: string) => theme.fg("warning", t),
            },
          );
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(null);
          container.addChild(list);

          const hintText =
            repos.length === 0
              ? "enter add repo • esc cancel"
              : "↑↓ navigate • enter select • esc cancel";
          container.addChild(
            new Text(theme.fg("dim", hintText), 1, 0),
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

      // Esc → cancel entire install
      if (action === null) return;

      if (action === "__add__") {
        // ── Add repo flow ──
        const newRepo = await ctx.ui.custom<string | null>(
          (tui, theme, _kb, done) => {
            let buffer = repos.length === 0 ? DEFAULT_REPO : "";

            const container = new Container();
            container.addChild(
              new DynamicBorder((s: string) => theme.fg("accent", s)),
            );
            container.addChild(
              new Text(
                theme.fg("accent", theme.bold("Add repo")),
                1,
                0,
              ),
            );
            container.addChild(
              new Text(
                theme.fg("muted", "Enter owner/repo:"),
                1,
                0,
              ),
            );

            // Render the current buffer inline
            const inputDisplay = new (class {
              render() {
                return [`  ${theme.fg("accent", buffer || " ")}`];
              }
              invalidate() {}
            })();
            container.addChild(inputDisplay);

            container.addChild(
              new Text(
                theme.fg("dim", "enter confirm • esc back"),
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
                const filtered = data.replace(/[\x00-\x1F\x7F]/g, '');
                if (filtered.length > 0) {
                  buffer += filtered;
                  tui.requestRender();
                }
              },
            };
          },
        );

        if (!newRepo) continue; // esc → back to repo picker

        try {
          addRepo(ctx.cwd, newRepo);
          selectedRepo = newRepo;
        } catch (err) {
          ctx.ui.notify(
            `pi-assert: ${String(err)}`,
            "error",
          );
          continue; // back to repo picker to try again
        }
      } else {
        selectedRepo = action;
      }
    }

    // ── Step 1: fetch and pick a rule file ──
    let files: Awaited<ReturnType<typeof fetchRuleFiles>>;
    try {
      files = await fetchRuleFiles(selectedRepo);
    } catch (err) {
      ctx.ui.notify(
        `pi-assert: failed to fetch rule files — ${String(err)}`,
        "error",
      );
      return;
    }

    if (files.length === 0) {
      ctx.ui.notify(`No rule files found in ${selectedRepo}.`, "info");
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
            theme.fg(
              "accent",
              theme.bold(`Rule Files (${selectedRepo})`),
            ),
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
      entries = await fetchRuleFile(selectedRepo, selectedFile);
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
      installRule(ctx.cwd, selectedRepo, selectedName, entry);

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

        // Prune any stale active entries that no longer exist in the file
        const validNames = new Set(asserts.map((a) => a.name));
        for (const name of activeAsserts) {
          if (!validNames.has(name)) activeAsserts.delete(name);
        }
        updateStatus(ctx);

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

            // ── Group asserts by source ──
            const bySource = new Map<string, Assert[]>();
            for (const a of asserts) {
              const list = bySource.get(a.source) ?? [];
              list.push(a);
              bySource.set(a.source, list);
            }
            // Order: local first, repos alphabetically
            const sectionOrder = Array.from(bySource.keys()).sort((a, b) => {
              if (a === "local") return -1;
              if (b === "local") return 1;
              return a.localeCompare(b);
            });

            // ── Per-section lists ──
            interface Section {
              source: string;
              asserts: Assert[];
              list: SettingsList;
            }
            const sections: Section[] = [];
            let focusedSection = 0;
            let confirmName: string | null = null;
            let confirmSource: string | null = null;

            if (sectionOrder.length > 0) {
              // Pre-calculate total line count for maxVisible across all lists
              const totalItems = asserts.length;
              const perListMax = Math.max(
                3,
                Math.min(10, Math.ceil(15 / sectionOrder.length)),
              );

              for (const source of sectionOrder) {
                const group = bySource.get(source)!;
                const items: SettingItem[] = group.map((a) => ({
                  id: a.name,
                  label: a.name,
                  currentValue: activeAsserts.has(a.name)
                    ? "enabled"
                    : "disabled",
                  values: ["enabled", "disabled"],
                }));

                const sl = new SettingsList(
                  items,
                  Math.min(items.length + 3, perListMax),
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

                sections.push({ source, asserts: group, list: sl });
              }

              // ── Render wrapper: section headers + lists ──
              const renderer = new (class {
                render(width: number) {
                  if (confirmName && confirmSource) {
                    const msg = `Remove "${confirmName}"? ${theme.fg("accent", "y")}/${theme.fg("dim", "n")}`;
                    return ["", `  ${msg}`, ""];
                  }

                  const lines: string[] = [];
                  for (let i = 0; i < sections.length; i++) {
                    const sec = sections[i];
                    const isFocused = i === focusedSection;

                    // Section header
                    if (sec.source !== "local") {
                      lines.push(
                        `  ${theme.fg(isFocused ? "accent" : "muted", sec.source)}`,
                      );
                    } else {
                      lines.push(
                        `  ${theme.fg(isFocused ? "accent" : "muted", "Local")}`,
                      );
                    }

                    // List (or dimmed text if not focused)
                    if (isFocused) {
                      const listLines = sec.list.render(width);
                      // Strip SettingsList's built-in hint (last 2 lines)
                      if (
                        listLines.length >= 2 &&
                        listLines[listLines.length - 2] === "" &&
                        listLines[listLines.length - 1]?.includes(
                          "Enter/Space to change",
                        )
                      ) {
                        listLines.length -= 2;
                      }
                      for (const l of listLines) lines.push(l);
                    } else {
                      for (const a of sec.asserts) {
                        const status = activeAsserts.has(a.name)
                          ? theme.fg("muted", "enabled")
                          : theme.fg("dim", "disabled");
                        lines.push(`   ${theme.fg("muted", a.name)}  ${status}`);
                      }
                    }
                    if (i < sections.length - 1) lines.push("");
                  }

                  // Hint — built by concatenating theme fragments so
                  // no plain-text gaps appear between ANSI resets.
                  const dim = (s: string) => theme.fg("dim", s);
                  const acc = (s: string) => theme.fg("accent", s);
                  const focused2 = sections[focusedSection];
                  const hint =
                    dim("  Enter/Space to change · ") +
                    (focused2?.source !== "local"
                      ? acc("d") + dim(" Remove · ")
                      : "") +
                    acc("i") +
                    dim(" Install asserts · Esc to cancel");
                  lines.push("", hint);

                  return lines;
                }
                invalidate() {
                  for (const sec of sections) sec.list.invalidate();
                }
              })();
              container.addChild(renderer);

              return {
                render(width: number) {
                  return container.render(width);
                },
                invalidate() {
                  container.invalidate();
                },
                handleInput(data: string) {
                  // ── Confirmation mode ──
                  if (confirmName && confirmSource) {
                    if (matchesKey(data, "y")) {
                      removeRule(ctx.cwd, confirmSource, confirmName);
                      activeAsserts.delete(confirmName);
                      persistState();
                      done("reload");
                      return;
                    }
                    if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
                      confirmName = null;
                      confirmSource = null;
                      container.invalidate();
                      tui.requestRender();
                      return;
                    }
                    return;
                  }

                  // ── Global hotkeys ──
                  if (matchesKey(data, "i")) {
                    done("install");
                    return;
                  }
                  if (matchesKey(data, Key.escape)) {
                    done(null);
                    return;
                  }

                  const curr = sections[focusedSection];

                  // ── d: remove selected assert (non-local only) ──
                  if (matchesKey(data, "d")) {
                    if (!curr || curr.source === "local") {
                      ctx.ui.notify(
                        "Local asserts cannot be removed from the UI",
                        "info",
                      );
                      return;
                    }
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const selIdx = (curr.list as any)?.selectedIndex ?? -1;
                    const selected = curr.asserts[selIdx];
                    if (selected) {
                      confirmName = selected.name;
                      confirmSource = curr.source;
                      container.invalidate();
                      tui.requestRender();
                    }
                    return;
                  }

                  // ── Arrow keys: cross section boundaries ──
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const currIdx = (curr.list as any)?.selectedIndex ?? 0;
                  const currLen = curr.asserts.length;

                  if (matchesKey(data, "up") && currIdx === 0 && focusedSection > 0) {
                    focusedSection--;
                    const prev = sections[focusedSection];
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (prev.list as any).selectedIndex = prev.asserts.length - 1;
                    container.invalidate();
                    tui.requestRender();
                    return;
                  }
                  if (
                    matchesKey(data, "down") &&
                    currIdx >= currLen - 1 &&
                    focusedSection < sections.length - 1
                  ) {
                    focusedSection++;
                    const next = sections[focusedSection];
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (next.list as any).selectedIndex = 0;
                    container.invalidate();
                    tui.requestRender();
                    return;
                  }

                  // Delegate to focused section's list
                  curr.list.handleInput(data);
                  tui.requestRender();
                },
              };
            }

            // ── Empty state ──
            container.addChild(
              new Text(
                theme.fg("dim", "No asserts defined."),
                1,
                0,
              ),
            );

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
              },
            };
          },
          {},
        );

        if (action !== "install" && action !== "reload") break;

        if (action === "install") {
          // Run install, then loop back to show the updated toggle UI
          await installFlow(ctx);
        }
        // "reload" just loops back to reload from file
      }
    },
  });

  // -----------------------------------------------------------------------
  // Intercept tool calls
  // -----------------------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    const activeList = asserts.filter((a) => activeAsserts.has(a.name));
    const result = await executeToolCallAsserts(activeList, event, ctx);

    if (result) {
      if (ctx.hasUI) {
        ctx.ui.notify(result.reason, "error");
      }
      return result;
    }
  });

  // -----------------------------------------------------------------------
  // Agent-end asserts (run when the agent finishes a prompt and goes idle)
  // -----------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    const agentEndEvent = event as unknown as AgentEndEvent;
    const activeList = asserts.filter((a) => activeAsserts.has(a.name));
    const failures = await executeAgentEndAsserts(activeList, agentEndEvent, ctx);

    if (failures.length > 0) {
      const body =
        `${failures.length} assertion${failures.length === 1 ? "" : "s"} failed after your last turn:\n\n` +
        failures.join("\n");

      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-assert: ${failures.length} agent_end assertion${failures.length === 1 ? "" : "s"} failed`,
          "warning",
        );
      }

      // Inject a custom message so the agent sees the failure and can fix it
      pi.sendMessage(
        {
          customType: "pi-assert",
          content: body,
          display: true,
        },
        { triggerTurn: true },
      );
    }
  });
}
