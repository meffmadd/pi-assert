---
name: pi-assert
description: Define shell-based assertions in .pi/asserts.json that block pi tool calls. Use when adding security guards, path protections, or custom tool-call policies.
---

# pi-assert

pi-assert is a pi extension that reads an `asserts.json` file and enforces
shell-based assertions against pi events. Each assert lets you block specific
tool invocations, patch tool results, or run checks when the agent finishes
a turn, all based on a shell command's exit code.

## asserts.json Format

The file lives at `.pi/asserts.json` (project) or `~/.pi/asserts.json`
(global).  Keys are assert names; project overrides global by name.

```json
{
  "my-assert-name": {
    "hook": "tool_call",
    "filter": { "toolName": "write" },
    "shell": "false"
  }
}
```

### $schema

For editor autocompletion and validation, add a `"$schema"` key pointing to the
raw GitHub URL (or a local path during development):

```json
{
  "$schema": "https://raw.githubusercontent.com/<user>/pi-assert/main/schema.json",
  "my-assert": { ... }
}
```

VS Code and other editors will then provide:
- Autocomplete for `hook`, `filter`, `shell`, `default`
- Red squiggles on typos, missing required fields, or unknown properties
- Hover tooltips with field descriptions
- Enum suggestions (`"tool_call"`, `"tool_result"`, `"agent_end"` for `hook`)

### Fields

| Field    | Required | Description |
|----------|----------|-------------|
| `hook`   | yes      | Pi event name: `"tool_call"`, `"tool_result"`, or `"agent_end"`. |
| `filter` | no       | Key-value object matched against the event's candidate record. For `tool_call` and `tool_result`: `{ toolName, ...event.input }`. For `agent_end`: `{ event: "agent_end" }`. Omitted → fires on every matching event. Each value may be a scalar (strict `===` match) or an **array** — an array means "any of": the candidate value matches if it equals any element (e.g. `{ "toolName": ["write", "edit"] }` runs on either). An empty array matches nothing. |
| `when`   | no       | Optional precondition shell command. The main `shell` only runs when this exits 0. Use to skip expensive asserts when they don't apply (e.g., only check writes to `.env` if the working tree is dirty). |
| `shell`   | yes      | Shell command string. Pipes, redirects, `&&`, `||` all work — runs through a real shell. Exit 0 → allow; non-zero → block (or warn, for session_shutdown). |
| `default` | no       | If `true`, this assert is active by default for new sessions. Defaults to `false` (inactive until manually enabled via `/asserts`). |

## Environment Variables

### tool_call hooks

| Variable          | Description |
|-------------------|-------------|
| `PI_TOOL_NAME`    | Tool being called (e.g. `"bash"`, `"write"`) |
| `PI_TOOL_CALL_ID` | Unique call identifier |
| `PI_TOOL_INPUT`   | Tool input as a single-line JSON string |
| `PI_CWD`          | Current working directory |

### tool_result hooks

| Variable           | Description |
|--------------------|-------------|
| `PI_TOOL_NAME`     | Tool that ran (e.g. `"read"`, `"bash"`) |
| `PI_TOOL_CALL_ID`  | Unique call identifier |
| `PI_TOOL_INPUT`    | Tool input as a single-line JSON string |
| `PI_TOOL_RESULT`   | Tool result text content joined by newlines. Image content blocks are skipped. |
| `PI_TOOL_IS_ERROR` | `"true"` or `"false"` — the tool's own error flag |
| `PI_CWD`           | Current working directory |

### agent_end hooks

| Variable    | Description |
|-------------|-------------|
| `PI_EVENT`  | Always `"agent_end"` |
| `PI_CWD`    | Current working directory |

## How to Add an Assert

1. Create or edit `.pi/asserts.json` in your project root (or `~/.pi/asserts.json` for global).
2. Add a key with a descriptive name.
3. Specify the `hook`, optional `filter`, and a `shell` command.
4. Reload pi with `/reload` (or restart).

## Installing Asserts from a Rules Repo

Run `/asserts` and choose **install** to browse a rules repo (default
`meffmadd/pi-assert-rules`) and install individual asserts into your
project's `.pi/asserts.json`. The repo's `rules/` directory holds `.json`
files, each a map of assert names to `RuleEntry` objects (with a
`description` field that the installer strips on install).

**Nested directories.** Rule files may be organised into subdirectories
under `rules/`, arbitrarily deep:

```
rules/
  defaults.json
  security/
    writes.json
    reads.json
  git/no-force-push.json
```

The picker lists every `.json` file flat, sorted by path, with the
intermediate directories shown in the label (`security/writes`).
Nesting is purely a remote organisational concern — each installed
assert lands in the flat `owner/repo` section of your `.pi/asserts.json`
keyed by the assert's own `name`, exactly as a flat-layout install would.

**Name uniqueness across the repo.** Assert names must be unique within
a file, and *should* be unique across the whole repo. Two files that
define an assert with the same `name` will overwrite each other on
install (last install wins); the installer shows a warning notification
when an install overwrites an existing assert.

**Install flow.** After installing, updating, or removing an assert, the
entry picker reopens for the *same* file on the last highlighted row so you
can act on several asserts from it in a row; press `Esc` to drop back to the
file picker, and `Esc` again to exit.

Each entry is classified against your local install for the chosen repo, and
both the badge and the hintline reflect the focused entry's state:

| Focused entry state        | Badge | Hintline          | `Enter` does                          |
|----------------------------|-------|-------------------|----------------------------------------|
| not installed              | (none)| `Enter install`   | install it                             |
| installed, content differs | `↑`   | `Enter update`    | update in place (preserves `default`)  |
| installed, up to date      | `✓`   | `Enter uninstall` | confirm → uninstall                    |

`Enter` is a unified tri-state: install, update, or (with a `y/n` confirm)
uninstall. The `default` flag is a local-only preference — it's excluded from
the content comparison, so an update never clobbers your `default` toggle.
Updates write to the owning file (project override or global), preserving the
on-disk `default`.

**Orphaned asserts.** The `/asserts` panel fetches each repo's entries (cached
per session) and marks installed asserts whose name no longer exists upstream
with a `⚠` badge. Remove an orphaned assert with the existing `r` → `y/n`
confirm flow. The fetch is async — badges appear once it settles; network
failures degrade silently (no `⚠`, retryable on the next open).

## Common Patterns

### Conditional asserts with `when` (skip expensive checks)

The `when` field is a precondition — when it fails, the assert is skipped entirely.
Use it for **dynamic runtime conditions** that `filter` cannot express (dirty git
state, file existence, environment checks, etc.):

```json
{
  "block-write-when-dirty": {
    "hook": "tool_call",
    "filter": { "toolName": "write" },
    "when": "git diff --quiet",
    "shell": "false"
  }
}
```

Without `when`, every write would be blocked. With `when`, writes are blocked only
when the working tree is dirty — a cheap shell check before the assert kicks in.

### Array filters — run on one of several tools

Any filter value can be an array, meaning "any of". The most common use is
matching several tool names with one assert instead of duplicating it:

```json
{
  "block-writes": {
    "hook": "tool_call",
    "filter": { "toolName": ["write", "edit"] },
    "shell": "false"
  }
}
```

This runs on `write` **or** `edit` (and only those). A single-element array is
equivalent to a scalar, and an empty array matches nothing. The rule applies
to every filter key, not just `toolName` — e.g. `{ "command": ["ls", "pwd"] }`
matches a `bash` call whose `command` is either.

### Block all write tool calls (require edit instead)

```json
{
  "unmodified": {
    "hook": "tool_call",
    "filter": { "toolName": "write" },
    "shell": "false"
  }
}
```

### Guard specific file paths

```json
{
  "protect-env-files": {
    "hook": "tool_call",
    "filter": { "toolName": "write" },
    "shell": "echo \"$PI_TOOL_INPUT\" | grep -q '\\.env' && exit 1 || exit 0"
  }
}
```

### Check bash commands for dangerous patterns

```json
{
  "no-secrets-in-env": {
    "hook": "tool_call",
    "filter": { "toolName": "bash" },
    "shell": "grep -q SECRET_KEY <<< \"$PI_TOOL_INPUT\" && exit 1 || exit 0"
  }
}
```

```json
{
  "block-rm-rf": {
    "hook": "tool_call",
    "filter": { "toolName": "bash" },
    "shell": "grep -qE 'rm[[:space:]]+-rf' <<< \"$PI_TOOL_INPUT\" && exit 1 || exit 0"
  }
}
```

### Allow writes only inside specific directories

```json
{
  "write-only-in-src": {
    "hook": "tool_call",
    "filter": { "toolName": "write" },
    "shell": "echo \"$PI_TOOL_INPUT\" | grep -q '\"path\":\"src/' && exit 0 || exit 1"
  }
}
```

### Block read of sensitive paths

```json
{
  "no-sensitive-reads": {
    "hook": "tool_call",
    "filter": { "toolName": "read" },
    "shell": "echo \"$PI_TOOL_INPUT\" | grep -qE '\\.(env|pem|key)' && exit 1 || exit 0"
  }
}
```

### Block secret patterns in tool results (tool_result hook)

The `tool_result` hook fires after a tool runs and can **patch the result**
when an assert fails — replacing the content with a redacted `[BLOCKED]`
message and marking `isError: true` so the LLM never sees the original
output. This is the only place to catch what a tool *returned* (e.g., a
secret that leaked through an innocuous `read` of a `.env` file).

```json
{
  "no-secrets-in-reads": {
    "hook": "tool_result",
    "filter": { "toolName": "read" },
    "shell": "grep -qE '^[A-Z_]+=' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0"
  }
}
```

Block PEM private keys regardless of which tool returned them:

```json
{
  "no-pem-blocks": {
    "hook": "tool_result",
    "shell": "grep -qE -e '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0"
  }
}
```

Defense-in-depth: block `read` results whose input path looks sensitive
(useful when the `tool_call` filter is misconfigured):

```json
{
  "block-sensitive-paths": {
    "hook": "tool_result",
    "filter": { "toolName": "read" },
    "shell": "echo \"$PI_TOOL_INPUT\" | grep -qE '\"path\":\"[^\"]*(\\.env|\\.pem|\\.key|id_rsa)' && exit 1 || exit 0"
  }
}
```

### Agent-end asserts

Agent-end asserts run after the agent finishes processing a prompt and goes
idle. If any fail, the failures are batched into a custom message and a new
turn is triggered so the agent can fix the issue.

```json
{
  "ensure-clean-tree": {
    "hook": "agent_end",
    "shell": "git diff --quiet",
    "default": true
  }
}
```

Multiple agent-end asserts batch into a single message:

```json
{
  "lint-passes": {
    "hook": "agent_end",
    "shell": "npx eslint . --quiet",
    "default": true
  },
  "tests-pass": {
    "hook": "agent_end",
    "shell": "npm test",
    "default": false
  }
}
```

## Behavior

1. Asserts are loaded from `.pi/asserts.json` at session start.
2. Only asserts with `"default": true` are active initially. Others must be enabled via `/asserts`. Once toggled, the selection persists across session restarts.
3. On each `tool_call`, all active, matching asserts run FIFO (first non-passing assert blocks the tool).
4. On each `tool_result`, all active, matching asserts run FIFO. The first non-passing assert replaces the result content with a `[BLOCKED by pi-assert]` message and marks it as an error so the LLM never sees the original output.
5. On `agent_end`, all active, matching asserts run FIFO. Failures are batched into a custom message and trigger a new turn so the agent can address them.
6. A block shows an error notification in the TUI.
7. The `false` Unix command always exits 1 — use it for unconditional blocks.
8. If either `asserts.json` fails to parse, pi-assert shows an error notification naming the file and the parse error, **no asserts are loaded**, and the status bar shows `pi-assert: config error (N files)` until the file is fixed. This is a hard-fail — a broken config blocks all asserts, even from a working sibling file.
9. Installing an assert that overwrites an existing one in the same repo section shows a warning notification; the install still succeeds (last install wins).
10. **Runtime visibility:** when any assert's `shell` actually runs (filter matched + `when` passed/absent), pi-assert tracks its duration. After each hook that ran at least one assert, a transient **info toast** is shown in the TUI — e.g. `pi-assert ran 3 commands in 19ms`. This is purely a notification: it never enters the conversation, never triggers a turn, and the agent never sees it. It's omitted entirely when a hook ran no asserts, and it surfaces passing asserts too, giving visibility into the guard layer. Asserts skipped by a `when` precondition are not recorded (they never triggered). The runtime toast is separate from the failure path: failures are still reported as actionable messages so the agent can address them.

## Toggling `default` from the UI

In the `/asserts` panel, press `t` on the focused assert to flip its
`default` flag in the source `asserts.json` (project or global,
whichever owns the entry). Defaults-marked asserts are tagged with
`(default)` in the panel. Note: toggling `default` only affects
**future** sessions with no saved session config; the current
session's active set is unchanged — press `Enter` to
enable/disable the assert right now (`Space` is no longer a toggle; it's a
query character in fuzzy-search mode).

## Disabling all / removing asserts

In the `/asserts` panel, press `d` to disable every active assert at once
(the selection persists across sessions), or `r` on the focused assert to
remove it from its `asserts.json` (prompts for confirmation). The `d Disable
all` hint only appears when at least one assert is active. Asserts removed
from their source repo (orphaned) are marked with `⚠`.

## Cycling between sections

The `/asserts` panel groups asserts by source (`local`, then each repo
alphabetically). Press `Tab` / `Shift+Tab` to cycle focus between sections
with wraparound (last wraps to first). It's a discrete jump that preserves
each section's remembered row — Tab away and Shift+Tab back lands you on
the same assert. The hint only appears when more than one section exists.

## Fuzzy search

In the `/asserts` panel, press `/` to enter fuzzy-search mode and narrow the
list by typing. Matching is fuzzy subsequence, ranked best-first **within each
section** — sections are preserved, non-matching rows hide within their
section, and empty sections disappear entirely. Spaces in the query are
ignored for matching, so `no env` still matches `no-env`. Matched
characters are highlighted inline — in the name within each row, and in
the `shell`/`when` detail block under the focused row.

While search is active: `↑`/`Down` move through the filtered matches
(crossing to the next non-empty section at the boundaries), `Enter` toggles
the focused match, and `Tab`/`Shift+Tab` cycle between the non-empty
filtered sections. `Esc` exits search and lands focus back on the highlighted
match in the unfiltered view. Every printable character (including **Space**)
feeds the query, so `r`/`t`/`d`/`i` are suspended as actions during search —
press `Esc` first to use them. `/` is a no-op on an empty/broken panel.

Note: `Enter` (not `Enter`/`Space`) is the enable/disable key in both normal
and search mode; Space is a query character in search mode and a no-op
otherwise.
