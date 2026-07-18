# pi-assert

Shell guards for Pi tool calls. Assertions are loaded from project
`.pi/asserts.json` and global `~/.pi/asserts.json`; a project entry overrides a
global entry only when both its **source section and name** match.

## Quick start

```bash
pi install ./path/to/pi-assert
```

Create `.pi/asserts.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/pi-assert/main/schema.json",
  "local": {
    "unmodified": {
      "description": "Block direct writes",
      "hook": "tool_call",
      "filter": { "toolName": "write" },
      "shell": "false"
    },
    "no-rm-rf": {
      "description": "Block dangerous shell removal",
      "hook": "tool_call",
      "filter": { "toolName": "bash" },
      "shell": "echo \"$PI_TOOL_INPUT\" | grep -qE 'rm[[:space:]]+-rf' && exit 1 || exit 0"
    }
  }
}
```

## Format

The top-level object is sectioned by source. `local` contains hand-written
rules; an `owner/repo` section contains installed rules. `repos` declares repo
sources available to the installer.

```json
{
  "repos": ["owner/rules"],
  "local": {
    "check-tree": {
      "description": "Require a clean tree at turn end",
      "hook": "agent_end",
      "shell": "git diff --quiet",
      "default": true
    }
  },
  "owner/rules": {
    "hide-secrets": {
      "description": "Redact secret-looking read results",
      "hook": "tool_result",
      "filter": { "toolName": "read" },
      "shell": "grep -q SECRET \"$PI_TOOL_RESULT\" && exit 1 || exit 0"
    }
  }
}
```

Shell assertions require `description`, `hook` (`tool_call`, `tool_result`, or
`agent_end`), and `shell`. Optional `filter`, `when`, and boolean `default`
are supported. Filters match tool input plus a trusted `toolName`; `when`
only skips on an ordinary non-zero exit—timeouts and execution failures block.
Shells run with `PWD` and `PI_CWD` set to the Pi project directory.

A preset replaces shell fields with a `preset` array of qualified refs:

```json
{
  "local": {
    "safe-writes": {
      "description": "My write safeguards",
      "preset": ["local/unmodified", "owner/rules/protect-env"]
    }
  }
}
```

`tool_call` blocks a call, `tool_result` replaces a failed result with a
redacted error, and `agent_end` starts a corrective turn for failures. Use
`/asserts` to install, enable, disable, and manage rules and presets.

## Environment

Tool hooks receive `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and
`PI_CWD`; result hooks additionally receive `PI_TOOL_RESULT` and
`PI_TOOL_IS_ERROR`. Agent-end hooks receive `PI_EVENT=agent_end` and `PI_CWD`.

## License

MIT
