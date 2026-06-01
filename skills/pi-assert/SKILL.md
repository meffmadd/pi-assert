---
name: pi-assert
description: Define shell-based assertions in .pi/asserts.json that block pi tool calls. Use when adding security guards, path protections, or custom tool-call policies.
---

# pi-assert

pi-assert is a pi extension that reads an `asserts.json` file and enforces
shell-based assertions against pi tool calls. Each assert lets you block
specific tool invocations based on a shell command's exit code.

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
- Enum suggestions (`"tool_call"` for `hook`)

### Fields

| Field    | Required | Description |
|----------|----------|-------------|
| `hook`   | yes      | Pi event name. Currently only `"tool_call"`. |
| `filter` | no       | Key-value object matched against `{ toolName, ...event.input }`. If every key matches, the assert fires. Omitted → fires on every tool call. |
| `when`   | no       | Optional precondition shell command. The main `shell` only runs when this exits 0. Use to skip expensive asserts when they don't apply (e.g., only check writes to `.env` if the working tree is dirty). |
| `shell`   | yes      | Shell command string. Pipes, redirects, `&&`, `||` all work — runs through a real shell. Exit 0 → allow; non-zero → block. |
| `default` | no       | If `true`, this assert is active by default for new sessions. Defaults to `false` (inactive until manually enabled via `/asserts`). |

## Environment Variables

The shell command receives these environment variables:

| Variable          | Description |
|-------------------|-------------|
| `PI_TOOL_NAME`    | Tool being called (e.g. `"bash"`, `"write"`) |
| `PI_TOOL_CALL_ID` | Unique call identifier |
| `PI_TOOL_INPUT`   | Tool input as a single-line JSON string |
| `PI_CWD`          | Current working directory |

## How to Add an Assert

1. Create or edit `.pi/asserts.json` in your project root (or `~/.pi/asserts.json` for global).
2. Add a key with a descriptive name.
3. Specify the `hook`, optional `filter`, and a `shell` command.
4. Reload pi with `/reload` (or restart).

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

## Behavior

1. Asserts are loaded from `.pi/asserts.json` at session start.
2. Only asserts with `"default": true` are active initially. Others must be enabled via `/asserts`. Once toggled, the selection persists across session restarts.
3. On each `tool_call`, all active, matching asserts run FIFO (first non-passing assert blocks the tool).
4. A block shows an error notification in the TUI.
5. The `false` Unix command always exits 1 — use it for unconditional blocks.
