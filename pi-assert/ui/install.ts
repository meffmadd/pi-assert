import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
  addRepo,
  buildRepoPickerItems,
  DEFAULT_REPO,
  fetchRuleFile,
  fetchRuleFiles,
  getInstalledRepos,
  installRule,
  REPO_ADD_ACTION,
  type RuleEntries,
  type RuleEntry,
  type RuleFile,
} from "../installer.js";
import { selectDialog, textInputDialog } from "./components.js";
import type { AssertsState } from "./state.js";

// ---------------------------------------------------------------------------
// Step 1: pick (or add) a repo
// ---------------------------------------------------------------------------

/** Show the repo picker. Returns the chosen value (a repo or REPO_ADD_ACTION), or null on Esc. */
async function promptRepoChoice(
  ctx: ExtensionContext,
  repos: string[],
): Promise<string | null> {
  const hint =
    repos.length === 0
      ? "enter add repo • esc cancel"
      : "↑↓ navigate • enter select • esc cancel";
  return selectDialog<string>(ctx, {
    title: "Repos",
    items: buildRepoPickerItems(repos),
    hint,
  });
}

/** Prompt for a new repo name. Returns the trimmed input or null. */
async function promptNewRepo(
  ctx: ExtensionContext,
  initial: string | undefined,
): Promise<string | null> {
  return textInputDialog(ctx, {
    title: "Add repo",
    label: "Enter owner/repo:",
    hint: "enter confirm • esc back",
    initial,
  });
}

/**
 * Resolve the user's repo choice.  If they picked "Add repo…", prompt for
 * a name and register it.  Returns the chosen repo, or null on cancel/error.
 */
async function resolveRepo(
  ctx: ExtensionContext,
  choice: string,
  isFirstRepo: boolean,
): Promise<string | null> {
  if (choice !== REPO_ADD_ACTION) return choice;

  const newRepo = await promptNewRepo(ctx, isFirstRepo ? DEFAULT_REPO : undefined);
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
  const chosen = await selectDialog<string>(ctx, {
    title: `Rule Files (${repo})`,
    items,
    hint: "↑↓ navigate • enter open • esc cancel",
  });
  if (!chosen) return null;
  return files.find((f) => f.path === chosen) ?? null;
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

/** Show a picker over the parsed assert entries. Returns the chosen name or null. */
async function promptAssertEntry(
  ctx: ExtensionContext,
  file: RuleFile,
  entries: RuleEntries,
): Promise<string | null> {
  const fileName = file.path.replace(/^rules\//, "").replace(/\.json$/, "");
  const names = Object.keys(entries);
  const items: SelectItem[] = names.map((name) => {
    const e = entries[name]!;
    return { value: name, label: name, description: e.description };
  });
  return selectDialog<string>(ctx, {
    title: fileName,
    items,
    hint: "↑↓ navigate • enter install • esc back",
    detailFor: (value) => {
      const e = entries[value];
      if (!e) return undefined;
      return { shell: e.shell, when: e.when };
    },
  });
}

/** Fetch a rule file and prompt the user to pick an assert. */
async function fetchAndPromptEntry(
  ctx: ExtensionContext,
  repo: string,
  file: RuleFile,
): Promise<{ name: string; entry: RuleEntry } | null> {
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

  const name = await promptAssertEntry(ctx, file, entries);
  if (!name) return null;
  return { name, entry: entries[name]! };
}

// ---------------------------------------------------------------------------
// Install + state reload
// ---------------------------------------------------------------------------

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

  state.load(ctx.cwd);
  state.restore(ctx);
  state.updateStatus(ctx);
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

// ---------------------------------------------------------------------------
// runInstallWizard — linear state machine: pick repo → pick file → pick entry
// → install → loop back to pick another file from the same repo.
// ---------------------------------------------------------------------------
export async function runInstallWizard(
  ctx: ExtensionContext,
  state: AssertsState,
): Promise<void> {
  // Step 1: pick (or add) a repo
  const repos = getInstalledRepos(ctx.cwd);
  const choice = await promptRepoChoice(ctx, repos);
  if (choice === null) return;

  const repo = await resolveRepo(ctx, choice, repos.length === 0);
  if (!repo) return;

  // Steps 2–5: loop over rule files until the user escapes
  let file: RuleFile | null = await fetchAndPromptFile(ctx, repo);

  while (file) {
    const picked = await fetchAndPromptEntry(ctx, repo, file);
    if (!picked) {
      // Esc → back to file picker
      file = await fetchAndPromptFile(ctx, repo);
      continue;
    }

    installAndReload(ctx, state, repo, picked.name, picked.entry);

    // Back to file picker to install more
    file = await fetchAndPromptFile(ctx, repo);
  }
}
