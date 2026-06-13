import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  addRepo,
  fetchRuleFile,
  fetchRuleFiles,
  getInstalledRepos,
  installRule,
  type RuleEntries,
  type RuleFile,
} from "../installer.js";
import { selectDialog, textInputDialog } from "./components.js";
import type { AssertsState } from "./state.js";

const DEFAULT_REPO =
  process.env.PI_ASSERT_DEFAULT_REPO ?? "meffmadd/pi-assert-rules";

// ---------------------------------------------------------------------------
// Step 1: pick (or add) a repo
// ---------------------------------------------------------------------------
async function pickRepo(ctx: ExtensionContext): Promise<string | null> {
  const repos = getInstalledRepos(ctx.cwd);

  // Build items: each repo + "Add repo..." at the bottom
  const items: { value: string; label: string }[] = [
    ...repos.map((r) => ({ value: r, label: r })),
    { value: "__add__", label: "Add repo…" },
  ];

  const hint =
    repos.length === 0
      ? "enter add repo • esc cancel"
      : "↑↓ navigate • enter select • esc cancel";

  const action = await selectDialog<string>(ctx, {
    title: "Repos",
    items,
    hint,
  });

  if (action === null) return null; // Esc

  if (action === "__add__") {
    const newRepo = await textInputDialog(ctx, {
      title: "Add repo",
      label: "Enter owner/repo:",
      hint: "enter confirm • esc back",
      initial: repos.length === 0 ? DEFAULT_REPO : undefined,
    });

    if (!newRepo) return pickRepo(ctx); // Esc → back to picker

    try {
      addRepo(ctx.cwd, newRepo);
      return newRepo;
    } catch (err) {
      ctx.ui.notify(`pi-assert: ${String(err)}`, "error");
      return pickRepo(ctx); // back to picker
    }
  }

  return action;
}

// ---------------------------------------------------------------------------
// Step 2: pick a rule file from the repo
// ---------------------------------------------------------------------------
async function pickRuleFile(
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

  const chosen = await selectDialog<string>(ctx, {
    title: `Rule Files (${repo})`,
    items: files.map((f) => ({ value: f.path, label: f.name })),
    hint: "↑↓ navigate • enter open • esc cancel",
  });

  if (!chosen) return null;
  return files.find((f) => f.path === chosen) ?? null;
}

// ---------------------------------------------------------------------------
// Step 3: pick an assert entry from the file
// ---------------------------------------------------------------------------
async function pickAssertEntry(
  ctx: ExtensionContext,
  file: RuleFile,
  entries: RuleEntries,
): Promise<string | null> {
  const names = Object.keys(entries);
  if (names.length === 0) {
    ctx.ui.notify("No valid asserts in this file.", "info");
    return null;
  }

  const fileName = file.path.replace(/^rules\//, "").replace(/\.json$/, "");

  return selectDialog<string>(ctx, {
    title: fileName,
    items: names.map((name) => {
      const e = entries[name]!;
      return { value: name, label: name, description: e.description };
    }),
    hint: "↑↓ navigate • enter install • esc back",
  });
}

// ---------------------------------------------------------------------------
// runInstallWizard — the full wizard.  Loops back to the file picker
// after each install so the user can install multiple asserts from the
// same repo.
// ---------------------------------------------------------------------------
export async function runInstallWizard(
  ctx: ExtensionContext,
  state: AssertsState,
): Promise<void> {
  // ── Step 1: pick (or add) a repo ──
  const repo = await pickRepo(ctx);
  if (!repo) return;

  // ── Step 2+: loop over rule files until the user escapes ──
  let file: RuleFile | null = await pickRuleFile(ctx, repo);

  while (file) {
    // ── Step 3: fetch and parse the file ──
    let entries: RuleEntries;
    try {
      entries = await fetchRuleFile(repo, file.path);
    } catch (err) {
      ctx.ui.notify(
        `pi-assert: failed to load rule file — ${String(err)}`,
        "error",
      );
      file = await pickRuleFile(ctx, repo);
      continue;
    }

    // ── Step 4: pick an assert ──
    const name = await pickAssertEntry(ctx, file, entries);
    if (!name) {
      // Esc → back to file picker
      file = await pickRuleFile(ctx, repo);
      continue;
    }

    // ── Step 5: install ──
    const entry = entries[name]!;
    try {
      installRule(ctx.cwd, repo, name, entry);
      // Reload in-memory asserts so the new rule appears in /asserts
      state.load(ctx.cwd);
      state.restore(ctx);
      state.updateStatus(ctx);

      ctx.ui.notify(
        `pi-assert: installed "${name}". Use /asserts to enable it.`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(
        `pi-assert: failed to install "${name}" — ${String(err)}`,
        "error",
      );
    }

    // ── Step 6: back to file picker to install more ──
    file = await pickRuleFile(ctx, repo);
  }
}
