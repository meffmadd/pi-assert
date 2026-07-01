# pi-assert

Define asserts for Pi hooks as shell one-liners in `asserts.json`. Any tool call that violates these invariants gets blocked.

## Quick Start

```bash
pi install ./path/to/pi-assert
```

Create `.pi/asserts.json`:

```json
{
  "unmodified": {
    "hook": "tool_call",
    "filter": { "toolName": "write" },
    "shell": "false"
  },
  "no-rm-rf": {
    "hook": "tool_call",
    "filter": { "toolName": "bash" },
    "shell": "grep -qE 'rm[[:space:]]+-rf' <<< \"$PI_TOOL_INPUT\" && exit 1 || exit 0"
  }
}
```

Start pi — all `write` calls and dangerous `rm -rf` commands are now blocked.

## How It Works

1. On session start, pi-assert loads asserts from `.pi/asserts.json` (project)
   and `~/.pi/asserts.json` (global). Project keys override global.
2. On every `tool_call`, matching asserts run in order. A filter (if provided)
   is matched against `{ toolName, ...event.input }`.
3. The shell command runs with environment variables (`PI_TOOL_NAME`,
   `PI_TOOL_INPUT`, `PI_CWD`, etc.).
4. Exit 0 → allow. Non-zero → block with a TUI notification.

## Asserts Format

| Field | Required | Description |
|-------|----------|-------------|
| `hook` | yes | Pi event. Currently `"tool_call"`. |
| `filter` | no | Key-value match against tool call input. Each value may be a scalar or an array (array = "any of", e.g. `{ "toolName": ["write", "edit"] }`). |
| `shell` | yes | Shell command. Exit 0 = pass, non-zero = block. |

## Environment Variables

| Variable | Value |
|----------|-------|
| `PI_TOOL_NAME` | Tool name (e.g. `"bash"`, `"write"`) |
| `PI_TOOL_CALL_ID` | Unique call ID |
| `PI_TOOL_INPUT` | Full input as JSON string |
| `PI_CWD` | Current working directory |

## License

MIT
