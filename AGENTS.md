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
- **`pi-assert/ui/fuzzy.ts`** — pure fuzzy-match module for the `/asserts` panel search mode: `fuzzyMatch` (case-insensitive subsequence + numeric fuzz score), `matchQuery` (the v1a strip-spaces → v1b AND-of-tokens seam), `filterSection` (per-section ranker with numeric per-field tiers so field dominance is deterministic, plus an optional per-field `coerce` that joins a non-string field — a preset's `preset` refs — into the `", "`-joined string `renderAssertDetail` also highlights), and `highlightSegments` (splits a target into matched/unmatched runs for render-time highlighting, reusing `matchQuery` so highlights stay consistent with what ranked the row). No TUI deps, unit-testable in isolation.
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
- **`pi-assert/ui/sectioned-panel.ts`** — `SectionedPanel`, the shared base
  for the `/asserts` panel and the preset editor's assert picker. Owns the
  composition (`render`/`bodyLines`/windowing/`renderSectionHeader`/
  `moveFocus`), the search lifecycle, the section-header `Tab`/`Shift+Tab`
  jump-key hints, AND the shared input (`handleSearchInput`/`handleNavInput`/
  `toggleFocused`) so both views are identical except for panel-specific
  action keys (which live in each subclass `handleInput`).
- **`pi-assert/ui/preset-editor.ts`** — the preset editor's assert picker
  (`PresetEditorPanel`, a `SectionedPanel` subclass). Adds only the
  panel-specific hooks: header, hint, `renderSection` (`✓`/space membership
  badge), empty-state message, and the one panel-specific key (`Esc` = commit +
  back). Search, navigation, and toggle are inherited — no parallel path.
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
  validation, the assert run loop, list/dialog rendering, sectioned-panel
  composition + input, and text measuring/wrapping each live in a single
  module (`config.ts`, `executor.ts`, `ui/sectioned-panel.ts`,
  `ui/components.ts`, and pi-tui's `visibleWidth`/`wrapTextWithAnsi`
  respectively) that every caller builds on. When adding a new view or hook,
  extend the shared core instead of copying the logic — two copies will
  silently drift.
- **Sectioned panels share input, not just rendering.** `SectionedPanel`
  owns the search-mode block and the normal-mode navigation keys
  (`handleSearchInput`/`handleNavInput`) plus `toggleFocused`; the `/asserts`
  panel and the preset editor's assert picker are identical except for
  panel-specific action keys in each subclass `handleInput` (search first via
  `handleSearchInput`, then panel-specific keys, then `handleNavInput` last).
  The only keys that differ are the hint line and each panel's own actions
  (`i`/`n`/`p`/`d`/`r`/`t`/`e`/`Esc`=cancel in `/asserts`; `Esc`=commit in
  the preset editor).
- **Highlighting is a render concern, not a filter concern.** Search match
  highlighting recomputes `highlightSegments(query, field)` per visible field
  at render time rather than threading `FuzzyResult.positions` through the
  panel. The matching algorithm stays single-sourced in `matchQuery` (both
  `filterSection` and `highlightSegments` call it — reuse, not duplication);
  the redundant calls are microseconds and avoid a `FuzzyResult`/`SectionMatch`
  shape change, new panel-side positions state, and a second helper. The name
  highlights via the panel's `renderLabel` (one method shared by the active
  and inactive row paths); `shell`/`when` highlight in `renderAssertDetail`,
  pre-styled before the ANSI-aware `wrapTextWithAnsi` so highlights carry
  across wrapped lines. A `score === 0` dead path returns no segments, so a
  field lights up iff it contributed to ranking.  The `preset` field is
  fuzzy-ranked via a `coerce` join (`filterSection` joins the array with `", "`,
  the same join `renderAssertDetail` uses for the `asserts:` detail) at the
  `shell`/`when` tier, so a search for a ref name surfaces the referencing
  preset and highlights it across the joined string — the coerce output must
  match the renderer's join so highlight positions align with the rank.
- **Only local presets are editable; repo presets are read-only.** The `/asserts`
  panel's `e` action is gated on `source === "local"`; a non-local preset
  carries a `❄` (snowflake, dim) badge so the read-only state is visible at a
  glance, and three signals reinforce it when focused: the hint line shows
  `e Edit preset` **crossed out** (dim + `strikethrough` via the shared
  `HintItem` disabled flag), the detail block shows a `❄ non-editable — copy
  via n to customize` note (`readonlyDetailLines`), and pressing `e` anyway
  notifies (defensive). `editPresetRule` is local-only (writes in place via
  `updateRule`, preserving the on-disk `default`). Forking a repo preset to
  local on edit was removed — to customize a repo preset, copy its content
  into a new local preset via `n`. The `❄`/`§`/`⚠` badges are all
  text-presentation BMP glyphs (reliable single-width in monospace terminals),
  not emoji.
