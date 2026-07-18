---
name: pi-assert
description: Define shell-based assertions in .pi/asserts.json that block Pi tool calls or redact results.
---

# pi-assert

`pi-assert` reads sectioned `.pi/asserts.json` files. Use `local` for
hand-written rules and `owner/repo` sections for installed rules. Project
entries override global entries by **source and name**, not name alone.

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/pi-assert/main/schema.json",
  "repos": ["owner/rules"],
  "local": {
    "block-env-write": {
      "description": "Prevent writes to environment files",
      "hook": "tool_call",
      "filter": { "toolName": "write" },
      "shell": "echo \"$PI_TOOL_INPUT\" | grep -q '\\.env' && exit 1 || exit 0"
    },
    "clean-tree": {
      "description": "Require a clean tree after a turn",
      "hook": "agent_end",
      "shell": "git diff --quiet",
      "default": true
    }
  },
  "owner/rules": {
    "redact-secret-result": {
      "description": "Suppress leaked secrets from read results",
      "hook": "tool_result",
      "filter": { "toolName": "read" },
      "shell": "grep -q SECRET \"$PI_TOOL_RESULT\" && exit 1 || exit 0"
    }
  }
}
```

## Assert fields

Every shell assert requires `description`, `hook`, and `shell`.

- `hook`: `tool_call`, `tool_result`, or `agent_end`.
- `filter`: optional object of scalar values or scalar arrays. Tool candidates
  include the trusted `toolName` plus tool input; agent-end has
  `{ "event": "agent_end" }`.
- `when`: optional shell precondition. A normal non-zero exit skips the rule;
  timeout, abort, and spawn failure fail closed for guard hooks.
- `default`: optional boolean; enables the source-qualified entry for a new
  session.

Commands execute with `PWD` equal to `PI_CWD`. Tool hooks expose
`PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and `PI_CWD`; result hooks
also expose `PI_TOOL_RESULT` and `PI_TOOL_IS_ERROR`. Agent-end exposes
`PI_EVENT` and `PI_CWD`.

## Presets

A preset has `description`, a `preset` array, and optional boolean `default`;
it cannot contain shell-assert fields. Refs are `local/name` or
`owner/repo/name`.

```json
{
  "local": {
    "safe-defaults": {
      "description": "Enable local and installed write guards",
      "preset": ["local/block-env-write", "owner/rules/protect-env"]
    }
  }
}
```

Use `/asserts` to enable entries, browse repos, install presets and their
members, and edit local presets. A `tool_call` failure blocks the call; a
`tool_result` failure replaces output with a redacted error; `agent_end`
failures trigger a corrective turn.
