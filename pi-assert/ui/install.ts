import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
  addRepo,
  buildRepoPickerItems,
  classifyEntry,
  fetchRuleFile,
  fetchRuleFiles,
  getInstalledRepos,
  installRule,
  removeRule,
  updateRule,
  REPO_ADD_ACTION,
  type EntryState,
  type RuleEntries,
  type RuleEntry,
  type RuleFile,
} from "../installer.js";
import { type ShellAssert, type PresetAssert } from "../engine.js";
import {
  HINT_ENTER_CONFIRM,
  HINT_ENTER_INSTALL,
  HINT_ENTER_OPEN,
  HINT_ENTER_SELECT,
  HINT_ENTER_UNINSTALL,
  HINT_ENTER_UPDATE,
  HINT_ESC_BACK,
  HINT_ESC_CANCEL,
  selectDialog,
  textInputDialog,
  type SelectDialogResult,
} from "./components.js";
import type { AssertsState } from "./state.js";

// ---------------------------------------------------------------------------
// Step 1: pick (or add) a repo
// ---------------------------------------------------------------------------

/** Show the repo picker. Returns the chosen value (a repo or REPO_ADD_ACTION), or null on Esc. */
async function promptRepoChoice(
  ctx: ExtensionContext,
  repos: string[],
): Promise<SelectDialogResult<string>> {
  return selectDialog<string>(ctx, {
    title: "Repos",
    items: buildRepoPickerItems(repos),
    hint: [HINT_ENTER_SELECT, HINT_ESC_CANCEL],
  });
}

/** Prompt for a new repo name. Returns the trimmed input or null. */
async function promptNewRepo(
  ctx: ExtensionContext,
): Promise<string | null> {
  return textInputDialog(ctx, {
    title: "Add repo",
    label: "Enter owner/repo:",
    hint: [HINT_ENTER_CONFIRM, HINT_ESC_BACK],
  });
}

/**
 * Resolve the user's repo choice.  If they picked "Add repo…", prompt for
 * a name and register it.  Returns the chosen repo, or null on cancel/error.
 */
async function resolveRepo(
  ctx: ExtensionContext,
  choice: string,
): Promise<string | null> {
  if (choice !== REPO_ADD_ACTION) return choice;

  const newRepo = await promptNewRepo(ctx);
  if (!newRepo) return null;

  try {
    addRepo(ctx.cwd, newRepo);
    return newRepo;
  } catch (err) {
    ctx.ui.notify(`pi-assert: ${String(err)}`, "error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: pick a rule file from the repo
// ---------------------------------------------------------------------------

/** Show a picker over the fetched rule files. Returns the chosen file or null. */
async function promptRuleFile(
  ctx: ExtensionContext,
  repo: string,
  files: RuleFile[],
): Promise<RuleFile | null> {
  const items: SelectItem[] = files.map((f) => ({
    value: f.path,
    label: f.name,
  }));
  const result = await selectDialog<string>(ctx, {
    title: `Rule Files (${repo})`,
    items,
    hint: [HINT_ENTER_OPEN, HINT_ESC_CANCEL],
  });
  if (result.value === null) return null;
  return files.find((f) => f.path === result.value) ?? null;
}

/** Fetch the repo's rule files and prompt the user to pick one. */
async function fetchAndPromptFile(
  ctx: ExtensionContext,
  repo: string,
): Promise<RuleFile | null> {
  let files: RuleFile[];
  try {
    files = await fetchRuleFiles(repo);
  } catch (err) {
    ctx.ui.notify(
      `pi-assert: failed to fetch rule files — ${String(err)}`,
      "error",
    );
    return null;
  }

  if (files.length === 0) {
    ctx.ui.notify(`No rule files found in ${repo}.`, "info");
    return null;
  }

  return promptRuleFile(ctx, repo, files);
}

// ---------------------------------------------------------------------------
// Step 3: pick an assert entry from a rule file
// ---------------------------------------------------------------------------

/**
 * Entry picker for a single rule file.  Each entry is classified against the
 * installed entries for this repo, and both the badge and the hintline reflect
 * the focused entry's next action:
 *
 * - not installed → (no badge), `Enter install`
 * - outdated       → `↑` badge, `Enter update`
 * - installed      → `✓` badge, `Enter uninstall` (with a `y/n` confirm)
 *
 * Presets also show a `P` badge. `Enter` is a unified tri-state; the `r` Remove
 * binding is gone (Enter on an installed entry uninstalls, so `r` is redundant).
 * The installed map is caller-supplied (built from `state.asserts`, refreshed
 * by `reload` after each action) so marks/hints reflect the latest install state.
 */
async function promptAssertEntry(
  ctx: ExtensionContext,
  file: RuleFile,
  entries: RuleEntries,
  installedMap: Map<string, ShellAssert | PresetAssert>,
  initialIndex?: number,
): Promise<SelectDialogResult<string>> {
  const fileName = file.path.replace(/^rules\//, "").replace(/\.json$/, "");
  const theme = ctx.ui.theme;
  const names = Object.keys(entries);
  const items: SelectItem[] = names.map((name) => {
    const e = entries[name]!;
    return { value: name, label: name, description: e.description };
  });

  const stateFor = (name: string): EntryState =>
    classifyEntry(entries[name]!, installedMap.get(name));

  return selectDialog<string>(ctx, {
    title: fileName,
    items,
    initialIndex,
    mark: (item) => {
      const e = entries[item.value];
      const isPresetEntry = e && "preset" in e;
      const st = stateFor(item.value);
      let mark = "";
      if (isPresetEntry) mark += theme.fg("accent", "P ");
      if (st === "outdated") mark += theme.fg("warning", "↑ ");
      if (st === "installed") mark += theme.fg("success", "✓ ");
      return mark;
    },
    hintFor: (item) => {
      const st = stateFor(item.value);
      const enterHint =
        st === "not-installed"
          ? HINT_ENTER_INSTALL
          : st === "outdated"
            ? HINT_ENTER_UPDATE
            : HINT_ENTER_UNINSTALL;
      return [enterHint, HINT_ESC_CANCEL];
    },
    // `Enter` on an `"installed"` entry swaps to a y/n uninstall confirm
    // before the dialog resolves.  This `shouldConfirm` predicate MUST stay
    // in sync with the dispatch in `runInstallWizard` (the `"installed"`
    // branch calls `removeAndReload`): the confirm is purely a guard, and the
    // dispatch re-derives the state, so a mismatch would confirm-then-take-
    // the-wrong-action.  Both branch off the same `stateFor(...) ===
    // "installed"` test.
    confirmOnSelect: {
      shouldConfirm: (item) => stateFor(item.value) === "installed",
      title: "Uninstall",
      message: (item) => {
        const e = entries[item.value];
        const kind = e && "preset" in e ? "preset" : "assert";
        return `  Uninstall "${item.value}" ${kind}?`;
      },
    },
    detailFor: (value) => {
      const e = entries[value];
      if (!e) return undefined;
      if ("preset" in e) {
        return { preset: e.preset };
      }
      return { shell: e.shell, when: e.when };
    },
  });
}

/** Fetch a rule file's entries (null on error/empty). Split out so the wizard re-fetches only when the file changes. */
async function fetchEntries(
  ctx: ExtensionContext,
  repo: string,
  file: RuleFile,
): Promise<RuleEntries | null> {
  let entries: RuleEntries;
  try {
    entries = await fetchRuleFile(repo, file.path);
  } catch (err) {
    ctx.ui.notify(
      `pi-assert: failed to load rule file — ${String(err)}`,
      "error",
    );
    return null;
  }

  if (Object.keys(entries).length === 0) {
    ctx.ui.notify("No valid asserts in this file.", "info");
    return null;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Install + state reload
// ---------------------------------------------------------------------------

/** Shared install/remove reload tail. */
function reload(ctx: ExtensionContext, state: AssertsState): void {
  state.load(ctx.cwd);
  state.restore(ctx);
  state.updateStatus(ctx);
}

/**
 * Install a preset's members (cascade). For each ref in the preset:
 * - `local/*` → skip (local asserts aren't in a repo; missing = dangling §)
 * - `owner/repo/*` → fetch the repo's entries and install the named member if not installed
 *
 * Dedup by `source\x00name`; a missing member is skipped (preset installs anyway, shows §).
 */
function installPresetMembers(
  ctx: ExtensionContext,
  state: AssertsState,
  ref: string,
): void {
  const idx = ref.lastIndexOf("/");
  if (idx < 0) return; // invalid ref, skip
  const source = ref.slice(0, idx);
  const memberName = ref.slice(idx + 1);

  if (source === "local") {
    // Local asserts aren't in a repo; skip (will show § if missing)
    return;
  }

  // Check if already installed
  const alreadyInstalled = state.asserts.some(
    (a) => a.source === source && a.name === memberName,
  );
  if (alreadyInstalled) return;

  // Fetch the repo's entries and install the member if found
  (async () => {
    try {
      const repoEntries = await fetchRuleFiles(source);
      // Find which file contains the member
      for (const file of repoEntries) {
        const entries = await fetchRuleFile(source, file.path);
        if (memberName in entries) {
          const memberEntry = entries[memberName]!;
          installRule(ctx.cwd, source, memberName, memberEntry);
          ctx.ui.notify(
            `pi-assert: installed member "${memberName}" (via preset).`,
            "info",
          );
          return;
        }
      }
      ctx.ui.notify(
        `pi-assert: member "${memberName}" not found in ${source}.`,
        "warning",
      );
    } catch (err) {
      ctx.ui.notify(
        `pi-assert: failed to fetch member "${memberName}" — ${String(err)}`,
        "error",
      );
    }
  })();
}

function installAndReload(
  ctx: ExtensionContext,
  state: AssertsState,
  repo: string,
  name: string,
  entry: RuleEntry,
): void {
  let overwritten: boolean;
  try {
    overwritten = installRule(ctx.cwd, repo, name, entry);
  } catch (err) {
    ctx.ui.notify(
      `pi-assert: failed to install "${name}" — ${String(err)}`,
      "error",
    );
    return;
  }

  // Cascade: if installing a preset, install its members
  if ("preset" in entry) {
    for (const ref of entry.preset) {
      installPresetMembers(ctx, state, ref);
    }
  }

  reload(ctx, state);
  ctx.ui.notify(
    `pi-assert: installed "${name}". Use /asserts to enable it.`,
    "info",
  );
  if (overwritten) {
    ctx.ui.notify(
      `pi-assert: overwrote existing ${"preset" in entry ? "preset" : "assert"} "${name}" in "${repo}".`,
      "warning",
    );
  }
}

function removeAndReload(
  ctx: ExtensionContext,
  state: AssertsState,
  repo: string,
  name: string,
): void {
  let removed: boolean;
  try {
    removed = removeRule(ctx.cwd, repo, name);
  } catch (err) {
    ctx.ui.notify(
      `pi-assert: failed to remove "${name}" — ${String(err)}`,
      "error",
    );
    return;
  }
  reload(ctx, state);
  ctx.ui.notify(
    removed
      ? `pi-assert: removed "${name}".`
      : `pi-assert: "${name}" was not installed.`,
    "info",
  );
}

function updateAndReload(
  ctx: ExtensionContext,
  state: AssertsState,
  name: string,
  entry: RuleEntry,
  installed: ShellAssert | PresetAssert,
): void {
  // `installed.path` is set for repo-sourced entries (the only kind the
  // wizard reaches this branch for).  Guard explicitly instead of asserting
  // via `!` so a future caller with a local entry degrades gracefully.
  if (!installed.path) {
    ctx.ui.notify(
      `pi-assert: cannot update "${name}" — entry has no owning file.`,
      "error",
    );
    return;
  }
  let updated: boolean;
  try {
    updated = updateRule(installed.path, installed.source, name, entry);
  } catch (err) {
    ctx.ui.notify(
      `pi-assert: failed to update "${name}" — ${String(err)}`,
      "error",
    );
    return;
  }
  reload(ctx, state);
  ctx.ui.notify(
    updated
      ? `pi-assert: updated "${name}".`
      : `pi-assert: "${name}" was not found on disk; install instead.`,
    "info",
  );
}

// ---------------------------------------------------------------------------
// runInstallWizard — pick repo → pick file → loop the entry picker for that
// file (install/remove stay in the same file; Esc → file picker; Esc → exit).
// Entries are fetched once per file; the installed set is re-read each prompt
// so `✓` marks refresh immediately.
// ---------------------------------------------------------------------------
export async function runInstallWizard(
  ctx: ExtensionContext,
  state: AssertsState,
): Promise<void> {
  // Step 1: pick (or add) a repo
  const repos = getInstalledRepos(ctx.cwd);
  const choice = await promptRepoChoice(ctx, repos);
  if (choice.value === null) return;

  const repo = await resolveRepo(ctx, choice.value);
  if (!repo) return;

  // Step 2: pick a rule file.  Loop over files until the user escapes.
  let file: RuleFile | null = await fetchAndPromptFile(ctx, repo);

  while (file) {
    const entries = await fetchEntries(ctx, repo, file);
    if (!entries) {
      // Fetch failed / empty — back to the file picker.
      file = await fetchAndPromptFile(ctx, repo);
      continue;
    }

    // Loop the entry picker for this file; Esc drops back to the file picker.
    let index: number | undefined;
    for (;;) {
      // Build the installed map from the freshly-loaded state (refreshed by
      // `reload` after each action) so badges/hints reflect the latest install.
      // Include both shell asserts and presets for classification.
      const installedMap = new Map<string, ShellAssert | PresetAssert>();
      for (const a of state.asserts) {
        if (a.source === repo) installedMap.set(a.name, a);
      }

      const result = await promptAssertEntry(
        ctx,
        file,
        entries,
        installedMap,
        index,
      );
      if (result.value === null) break;

      // Tri-state Enter dispatch: classify the chosen name against the
      // installed map and act accordingly.  `confirmOnSelect` in
      // `promptAssertEntry` already gated the uninstall confirm for the
      // `"installed"` branch below — its `shouldConfirm` predicate MUST match
      // this dispatch's uninstall branch (both test `stateFor ===
      // "installed"`); see the comment there.
      const name = result.value;
      const repoEntry = entries[name]!;
      const installed = installedMap.get(name);
      const entryState = classifyEntry(repoEntry, installed);

      if (entryState === "not-installed") {
        installAndReload(ctx, state, repo, name, repoEntry);
      } else if (entryState === "outdated") {
        updateAndReload(ctx, state, name, repoEntry, installed!);
      } else {
        // "installed" → uninstall
        removeAndReload(ctx, state, repo, name);
      }

      index = result.index;
    }

    file = await fetchAndPromptFile(ctx, repo);
  }
}
