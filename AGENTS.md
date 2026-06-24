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
- **`pi-assert/executor.ts`** — runs active asserts per hook. The three hook
  handlers share one `runAsserts` core (filter → `when` → `shell`); each only
  supplies its candidate, env builder, and fail policy (`{value}` fail-fast vs
  `"continue"` collect).
- **`pi-assert/ui/components.ts`** — shared UI primitives: `renderDetailList`/
  `DetailList` (the selectable list with inline `shell:`/`when:` detail, used
  by both the `/asserts` panel and every install picker), `selectDialog`/
  `textInputDialog` (built on a shared `dialogShell`), and
  `renderAssertDetail`.
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
- **Prefer one shared implementation over two.** Format parsing, entry
  validation, the assert run loop, list/dialog rendering, and text
  measuring/wrapping each live in a single module (`config.ts`, `executor.ts`,
  `ui/components.ts`, and pi-tui's `visibleWidth`/`wrapTextWithAnsi`
  respectively) that every caller builds on. When adding a new view or hook,
  extend the shared core instead of copying the logic — two copies will
  silently drift.
