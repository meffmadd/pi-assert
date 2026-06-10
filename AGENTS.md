# pi-assert

Shell-assertion guard for pi. Reads `asserts.json` to block tool calls that
fail user-defined shell checks.

## Architecture

- **`pi-assert/index.ts`** — extension entry point. Subscribes to `session_start`
  (load config), `tool_call` (run matching asserts, block on failure), and
  `agent_end` (run matching asserts, inject user message on failure so the
  agent can address them).
- **`pi-assert/engine.ts`** — config loading (`loadAsserts`), filter matching
  (`matchFilter`), environment builder (`buildEnv`), and shell execution
  (`evaluateShell` via `child_process.exec`).
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
