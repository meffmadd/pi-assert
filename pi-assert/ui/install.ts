import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
  addRepo,
  buildRepoPickerItems,
  fetchRuleFile,
  fetchRuleFiles,
  getInstalledAssertNames,
  getInstalledRepos,
  installRule,
  removeRule,
  REPO_ADD_ACTION,
  type RuleEntries,
  type RuleEntry,
  type RuleFile,
} from "../installer.js";
import {
  HINT_ENTER_CONFIRM,
  HINT_ENTER_INSTALL,
  HINT_ENTER_OPEN,
  HINT_ENTER_SELECT,
  HINT_ESC_BACK,
  HINT_ESC_CANCEL,
  HINT_R_REMOVE,
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

/** Entry picker marking installed entries with `✓`; `r` on an installed entry returns `{ removed: true }`. `installed` and `initialIndex` are caller-supplied so marks/highlight refresh without a reload. */
async function promptAssertEntry(
  ctx: ExtensionContext,
  file: RuleFile,
  entries: RuleEntries,
  repo: string,
  installed: Set<string>,
  initialIndex?: number,
): Promise<SelectDialogResult<string>> {
  const fileName = file.path.replace(/^rules\//, "").replace(/\.json$/, "");
  const theme = ctx.ui.theme;
  const names = Object.keys(entries);
  const items: SelectItem[] = names.map((name) => {
    const e = entries[name]!;
    return { value: name, label: name, description: e.description };
  });
  return selectDialog<string>(ctx, {
    title: fileName,
    items,
    hint: [HINT_ENTER_INSTALL, HINT_R_REMOVE, HINT_ESC_CANCEL],
    initialIndex,
    mark: (item) => (installed.has(item.value) ? theme.fg("success", "✓ ") : ""),
    remove: { canRemove: (item) => installed.has(item.value) },
    detailFor: (value) => {
      const e = entries[value];
      if (!e) return undefined;
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
  reload(ctx, state);
  ctx.ui.notify(
    `pi-assert: installed "${name}". Use /asserts to enable it.`,
    "info",
  );
  if (overwritten) {
    ctx.ui.notify(
      `pi-assert: overwrote existing assert "${name}" in "${repo}".`,
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
      const result = await promptAssertEntry(
        ctx,
        file,
        entries,
        repo,
        getInstalledAssertNames(ctx.cwd, repo),
        index,
      );
      if (result.value === null) break;
      if (result.removed) removeAndReload(ctx, state, repo, result.value);
      else installAndReload(ctx, state, repo, result.value, entries[result.value]!);
      index = result.index;
    }

    file = await fetchAndPromptFile(ctx, repo);
  }
}
