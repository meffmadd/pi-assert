# pi-assert

Shell-assertion guard for pi. Reads `asserts.json` to block tool calls that
fail user-defined shell checks.

## Architecture

- **`pi-assert/index.ts`** — extension entry point. Subscribes to `session_start`
  (load config), `tool_call` (run matching asserts, block on failure),
  `tool_result` (run matching asserts, patch result with a redacted block on
  failure so the LLM never sees the original output), and `agent_end` (run
  matching asserts, inject custom message on failure so the agent can address
  them).
- **`pi-assert/engine.ts`** — config loading (`loadAsserts`), filter matching
  (`matchFilter`), environment builder (`buildEnv`), and shell execution
  (`evaluateShell` via `child_process.exec`).
- **`pi-assert/config.ts`** — single owner of the on-disk `asserts.json`
  format: `readSectionedFile`/`writeSectionedFile`, section identification
  (`iterSections`), and entry-shape validation (`validateEntryShape`). Shared
  by `engine.ts` (runtime loading) and `installer.ts` (install/remove/default
  writes) so neither re-derives the format.
- **`pi-assert/installer.ts`** — GitHub API fetching (`fetchRuleFiles`/
  `fetchRuleFile`, session-cached `fetchRepoEntries`), install/remove/update
  writers (`installRule`/`removeRule`/`updateRule`), and pure outdated-detection
  helpers (`cleanEntry`, `entryContentSignature`, `entryNeedsUpdate`,
  `classifyEntry`). `cleanEntry` is the single owner of the on-disk record
  shape, shared by `installRule` and `updateRule`.
- **`pi-assert/executor.ts`** — runs active asserts per hook. The three hook
  handlers share one `runAsserts` core (filter → `when` → `shell`); each only
  supplies its candidate, env builder, and fail policy (`{value}` fail-fast vs
  `"continue"` collect).
- **`pi-assert/ui/fuzzy.ts`** — pure fuzzy-match module for the `/asserts` panel search mode: `fuzzyMatch` (case-insensitive subsequence + numeric fuzz score), `matchQuery` (the v1a strip-spaces → v1b AND-of-tokens seam), and `filterSection` (per-section ranker with numeric per-field tiers so field dominance is deterministic). No TUI deps, unit-testable in isolation.
- **`pi-assert/ui/components.ts`** — shared UI primitives: `renderDetailList`/
  `DetailList` (the selectable list with inline `shell:`/`when:` detail, used
  by both the `/asserts` panel and every install picker), `selectDialog`/
  `textInputDialog` (built on a shared `dialogShell`), and
  `renderAssertDetail`. `selectDialog` supports a focus-aware dynamic hint
  (`hintFor`) and a confirm-on-select guard (`confirmOnSelect`).
- **`pi-assert/ui/install.ts`** — the install wizard (repo picker → file
  picker → entry picker). The entry picker is a tri-state `Enter`: not
  installed → install, outdated → update, installed → confirm → uninstall.
  Classification uses the pure `classifyEntry` against the in-memory installed
  map; `updateRule` writes to the owning file and preserves on-disk `default`.
- **`pi-assert/ui/asserts.ts`** — the `/asserts` panel. Detects orphaned
  asserts (installed names removed from their source repo) via an async,
  session-cached `fetchRepoEntries` on panel open, marking them with `⚠` and
  reusing the existing `r` remove flow.
- **`skills/pi-assert/SKILL.md`** — bundled skill describing the format, hooks,
  filters, shell, env vars, and common patterns.

## Key Design Decisions

- Shell commands run through `child_process.exec` → pipes, redirects, `&&`, `||`
  all work via `/bin/sh`.
- Optional `when` precondition shell runs first; main `shell` only executes if
  `when` exits 0. Skip expensive asserts when they don't apply.
- Default timeout of 5 seconds prevents hanging asserts.
- First non-passing assert blocks the tool (fail-fast). Others don't run.
- Project `.pi/asserts.json` overrides global `~/.pi/asserts.json` by key name.
- No special handling for `"false"` — it's just the Unix `false` command
  (always exits 1).
- **Search swaps `groups`/`nav`, not the renderer.** The `/asserts` panel's
  fuzzy-search mode filters by pointing `this.groups`/`this.nav` at filtered
  subsets of the same `Assert` objects (originals saved and restored on `Esc`).
  `bodyLines`, `renderSection`, and the windowing math run **unchanged** against
  the filtered model — one shared implementation, no parallel render path.
  Ranking is per-section (`filterSection`) so section grouping and order stay
  stable while matches rank inside each section; empty sections drop out.
- **Outdated detection excludes `default`.** The content signature
  (`entryContentSignature`) compares only repo-driven fields
  (`description`, `hook`, `shell`, `filter`, `when`); `default` is a local
  toggle, never a repo-driven change. `updateRule` preserves the on-disk
  `default` so an update never clobbers a user's preference.
- **Outdated is per-file; orphaned is panel-wide.** The install wizard entry
  picker detects outdated asserts (installed name, content differs) using the
  file already being browsed — no extra fetch. The `/asserts` panel detects
  orphaned asserts (installed name missing from the repo) via a session-cached
  `fetchRepoEntries`. Both degrade silently on network failure.
- **Prefer one shared implementation over two.** Format parsing, entry
  validation, the assert run loop, list/dialog rendering, and text
  measuring/wrapping each live in a single module (`config.ts`, `executor.ts`,
  `ui/components.ts`, and pi-tui's `visibleWidth`/`wrapTextWithAnsi`
  respectively) that every caller builds on. When adding a new view or hook,
  extend the shared core instead of copying the logic — two copies will
  silently drift.
