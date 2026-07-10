/**
 * End-to-end tests: tool_result orchestration exercised in isolation.
 *
 * Mirrors the structure of e2e.test.ts but for the tool_result hook. The
 * tool_result executor returns a patch (or undefined) that, when applied,
 * replaces the content with a redacted block and marks the result as an
 * error.
 *
 * Usage: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadAsserts,
  type Assert,
  type ToolResultEvent,
  type ExtensionContext,
} from "../pi-assert/engine.js";

import { executeToolResultAsserts, type RunRecord } from "../pi-assert/executor.js";

// ── Temp dir helpers ───────────────────────────────────────────────

let tmpRoot: string;
let savedHome: string | undefined;

function setupConfig(dir: string, json: object) {
  const d = join(tmpRoot, dir);
  mkdirSync(join(d, ".pi"), { recursive: true });
  writeFileSync(
    join(d, ".pi", "asserts.json"),
    JSON.stringify({ local: json }, null, 2),
  );
  return d;
}

before(() => {
  tmpRoot = join(tmpdir(), `pi-assert-e2e-tr-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = tmpRoot;
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
});

// ── Shared context & event builders ────────────────────────────────

const defaultCtx: ExtensionContext = { cwd: "/tmp" };

function makeReadResult(
  text: string,
  input: Record<string, unknown> = { path: "/f.ts" },
): ToolResultEvent {
  return {
    toolName: "read",
    toolCallId: "c1",
    input,
    content: [{ type: "text", text }],
    isError: false,
  };
}

function makeBashResult(
  text: string,
  input: Record<string, unknown> = { command: "ls" },
): ToolResultEvent {
  return {
    toolName: "bash",
    toolCallId: "c2",
    input,
    content: [{ type: "text", text }],
    isError: false,
  };
}

// ═══════════════════════════════════════════════════════════════════
// End-to-end: tool_result scenarios
// ═══════════════════════════════════════════════════════════════════

describe("e2e: tool_result orchestration", () => {
  // 7.1 ── No asserts → no patch ─────────────────────────────────

  it("no asserts loaded → returns undefined", async () => {
    const cwd = setupConfig("e2e-tr-empty", {});
    const asserts = loadAsserts(cwd);
    assert.strictEqual(asserts.length, 0);

    const event = makeReadResult("file contents");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 7.2 ── Assert with matching filter → patch returned ─────────

  it("single assert with matching filter → patch replaces content", async () => {
    const cwd = setupConfig("e2e-tr-secret-leak", {
      "no-secrets-in-reads": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell:
          "grep -qE 'SECRET|API_KEY|TOKEN' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);
    assert.strictEqual(asserts.length, 1);

    const event = makeReadResult("API_KEY=sk-12345\nDEBUG=true");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);

    assert.ok(result);
    assert.ok(result!.reason.includes("no-secrets-in-reads"));
    assert.ok(result!.reason.includes("read"));
    assert.strictEqual(result!.patch.isError, true);
    assert.strictEqual(result!.patch.content?.length, 1);
    assert.strictEqual(result!.patch.content![0]!.type, "text");
    assert.ok(
      (result!.patch.content![0] as { type: "text"; text: string }).text.includes(
        "BLOCKED",
      ),
    );
    assert.ok(
      (result!.patch.content![0] as { type: "text"; text: string }).text.includes(
        "no-secrets-in-reads",
      ),
    );
  });

  // 7.3 ── Filter doesn't match → no patch ───────────────────────

  it("filter on toolName doesn't match → assert skipped, no patch", async () => {
    const cwd = setupConfig("e2e-tr-filter-miss", {
      "no-secrets-in-reads": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    // bash event — filter fails
    const event = makeBashResult("API_KEY=sk-12345");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 7.4 ── Shell passes → no patch ───────────────────────────────

  it("shell passes (exit 0) → no patch", async () => {
    const cwd = setupConfig("e2e-tr-pass", {
      "allow-all-reads": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "true",
      },
    });

    const asserts = loadAsserts(cwd);

    const event = makeReadResult("clean content");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 7.5 ── Fail-fast: first matching assert wins ─────────────────

  it("fail-fast: first matching assert blocks, second never runs", async () => {
    const cwd = setupConfig("e2e-tr-failfast", {
      "block-all": {
        description: "d",
        hook: "tool_result",
        shell: "false",
      },
      "allow-read": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "true",
      },
    });

    const asserts = loadAsserts(cwd);
    assert.strictEqual(asserts.length, 2);

    const event = makeReadResult("anything");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);

    assert.ok(result);
    // "block-all" comes first with no filter, so it wins
    assert.ok(result!.reason.includes("block-all"));
    assert.ok(!result!.reason.includes("allow-read"));
  });

  // 7.6 ── Realistic .env leak scenario ──────────────────────────

  it("blocks .env-style content in read results", async () => {
    const cwd = setupConfig("e2e-tr-env-leak", {
      "block-env-reads": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read", path: "/app/.env" },
        shell: "grep -qE '^[A-Z_]+=' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    // .env content → blocked
    const envEvent = makeReadResult(
      "DATABASE_URL=postgres://localhost/db\nAPI_KEY=sk-12345",
      { path: "/app/.env" },
    );
    const blocked = await executeToolResultAsserts(asserts, envEvent, defaultCtx);
    assert.ok(blocked);
    assert.strictEqual(blocked!.patch.isError, true);

    // Non-.env path with same shape → filter fails → allowed
    const otherEvent = makeReadResult("DATABASE_URL=postgres://localhost/db", {
      path: "/app/config.ts",
    });
    const allowed = await executeToolResultAsserts(asserts, otherEvent, defaultCtx);
    assert.strictEqual(allowed, undefined);

    // .env path with safe content (no KEY=) → shell passes → allowed
    const safeEvent = makeReadResult("just a comment\nnothing here", {
      path: "/app/.env",
    });
    const safeResult = await executeToolResultAsserts(asserts, safeEvent, defaultCtx);
    assert.strictEqual(safeResult, undefined);
  });

  // 7.7 ── PEM private key detection ─────────────────────────────

  it("blocks PEM private key blocks in any tool result", async () => {
    const cwd = setupConfig("e2e-tr-pem", {
      "no-pem-blocks": {
        description: "d",
        hook: "tool_result",
        // Use `grep --` so a leading `-` in the pattern is not parsed as
        // a flag, and use `-e` to make the pattern explicit.
        shell:
          "grep -qE -e '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    const event = makeReadResult(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...",
    );
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.strictEqual(result!.patch.isError, true);

    // Non-PEM content → allowed
    const safeEvent = makeReadResult("just a normal file");
    const safeResult = await executeToolResultAsserts(asserts, safeEvent, defaultCtx);
    assert.strictEqual(safeResult, undefined);
  });

  // 7.8 ── Other hooks are skipped ───────────────────────────────

  it("asserts with non-tool_result hook are skipped", async () => {
    const asserts: Assert[] = [
      { name: "tool-call-guard", source: "local", description: "d", hook: "tool_call", filter: {}, shell: "false", default: false },
      { name: "agent-end-guard", source: "local", description: "d", hook: "agent_end", filter: {}, shell: "false", default: false },
    ];

    const event = makeReadResult("anything");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 7.9 ── when precondition: passes → main shell runs ────────────

  it("when passes → main shell runs and can patch", async () => {
    const cwd = setupConfig("e2e-tr-when-pass", {
      "conditional-guard": {
        description: "d",
        hook: "tool_result",
        when: "true",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    const event = makeReadResult("anything");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.ok(result!.reason.includes("conditional-guard"));
  });

  it("when fails → assert skipped entirely (no patch)", async () => {
    const cwd = setupConfig("e2e-tr-when-fail", {
      "only-on-errors": {
        description: "d",
        hook: "tool_result",
        when: "false",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    const event = makeReadResult("anything");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 7.10 ── PI_TOOL_RESULT is the joined text content ────────────

  it("shell sees all text content joined by newlines", async () => {
    const cwd = setupConfig("e2e-tr-multi-content", {
      "check-multi": {
        description: "d",
        hook: "tool_result",
        shell: "grep -q 'SECRET' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    // Two text blocks — the second contains a secret
    const event: ToolResultEvent = {
      toolName: "read",
      toolCallId: "c",
      input: { path: "/f" },
      content: [
        { type: "text", text: "header line" },
        { type: "text", text: "SECRET=hunter2" },
      ],
      isError: false,
    };

    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.strictEqual(result!.patch.isError, true);
  });

  // 7.11 ── isError on input event flows into PI_TOOL_IS_ERROR ──

  it("isError: true in event flows into PI_TOOL_IS_ERROR", async () => {
    const cwd = setupConfig("e2e-tr-iserror", {
      "check-iserror": {
        description: "d",
        hook: "tool_result",
        // Block any result that came from an erroring tool
        shell: "test \"$PI_TOOL_IS_ERROR\" = 'true' && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    // Error result → blocked
    const errEvent: ToolResultEvent = {
      toolName: "bash",
      toolCallId: "c",
      input: { command: "false" },
      content: [{ type: "text", text: "command failed" }],
      isError: true,
    };
    const blocked = await executeToolResultAsserts(asserts, errEvent, defaultCtx);
    assert.ok(blocked);

    // Success result → allowed
    const okEvent: ToolResultEvent = {
      toolName: "bash",
      toolCallId: "c",
      input: { command: "true" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    };
    const allowed = await executeToolResultAsserts(asserts, okEvent, defaultCtx);
    assert.strictEqual(allowed, undefined);
  });

  // 7.12 ── default-based activation ────────────────────────────

  it("only asserts with default:true are active for new sessions", async () => {
    const cwd = setupConfig("e2e-tr-defaults", {
      "always-active": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "false",
        default: true,
      },
      "opt-in": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "false",
        default: false,
      },
    });

    const allAsserts = loadAsserts(cwd);
    assert.strictEqual(allAsserts.length, 2);

    // Simulate restoreFromBranch
    const activeAsserts = new Set(
      allAsserts.filter((a) => a.default).map((a) => a.name),
    );
    const activeList = allAsserts.filter((a) => activeAsserts.has(a.name));
    assert.strictEqual(activeList.length, 1);
    assert.ok(activeAsserts.has("always-active"));

    const event = makeReadResult("anything");
    const result = await executeToolResultAsserts(activeList, event, defaultCtx);
    assert.ok(result);
    assert.ok(result!.reason.includes("always-active"));
    assert.ok(!result!.reason.includes("opt-in"));
  });

  // 7.13 ── patch.isError is true even when original event isError: false

  it("patch.isError is true on failure regardless of original isError", async () => {
    const cwd = setupConfig("e2e-tr-patch-iserror", {
      "always-block": {
        description: "d",
        hook: "tool_result",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    // Original event has isError: false
    const event: ToolResultEvent = {
      toolName: "read",
      toolCallId: "c",
      input: { path: "/f" },
      content: [{ type: "text", text: "clean content" }],
      isError: false,
    };

    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.strictEqual(result!.patch.isError, true);
  });

  // 7.14 ── patch.content[0].text contains the assert name and shell

  it("patch content includes assert name, tool name, and shell command", async () => {
    const cwd = setupConfig("e2e-tr-patch-content", {
      "secret-guard": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "grep -q 'TOKEN' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    const event = makeReadResult("TOKEN=abc");
    const result = await executeToolResultAsserts(asserts, event, defaultCtx);

    assert.ok(result);
    const text = (result!.patch.content![0] as { type: "text"; text: string }).text;
    assert.ok(text.startsWith("[BLOCKED by pi-assert]"));
    assert.ok(text.includes("secret-guard"));
    assert.ok(text.includes("read"));
    assert.ok(text.includes("grep -q 'TOKEN'"));
    assert.ok(text.includes("The original tool result was suppressed"));
  });

  // 7.15 ── details pass-through: defined details are preserved in patch

  it("patch includes event.details when defined (pass-through)", async () => {
    const cwd = setupConfig("e2e-tr-details-defined", {
      "block-all": {
        description: "d",
        hook: "tool_result",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    const details = { exitCode: 0, duration: 42, truncated: false };
    const event: ToolResultEvent = {
      toolName: "bash",
      toolCallId: "c",
      input: { command: "ls" },
      content: [{ type: "text", text: "file" }],
      isError: false,
      details,
    };

    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    // patch.details should be the same object reference (pass-through)
    assert.strictEqual(result!.patch.details, details);
  });

  // 7.16 ── details pass-through: undefined details stay undefined

  it("patch.details is undefined when event.details is undefined", async () => {
    const cwd = setupConfig("e2e-tr-details-undef", {
      "block-all": {
        description: "d",
        hook: "tool_result",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    const event: ToolResultEvent = {
      toolName: "read",
      toolCallId: "c",
      input: { path: "/f" },
      content: [{ type: "text", text: "x" }],
      isError: false,
      // details omitted
    };

    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    // The runner uses `!== undefined` to decide whether to overwrite, so
    // we pass through `undefined` explicitly. Asserting that the patch
    // field is `undefined` confirms pass-through behavior is safe.
    assert.strictEqual(result!.patch.details, undefined);
  });

  // 7.17 ── special characters: newlines in result content are preserved

  it("special characters (newlines) in PI_TOOL_RESULT are preserved", async () => {
    const cwd = setupConfig("e2e-tr-special-newlines", {
      "find-secret": {
        description: "d",
        hook: "tool_result",
        shell: "grep -q 'SECRET=hunter2' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    // Multi-line content with mixed indentation
    const multiLine = "DEBUG=true\n\tSECRET=hunter2\n# comment\nPATH=/usr/bin";
    const event = makeReadResult(multiLine);

    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.strictEqual(result!.patch.isError, true);
  });

  // 7.18 ── special characters: quotes, backslashes, dollar signs

  it("special characters (quotes, backslashes, $vars) in result are handled by shell", async () => {
    const cwd = setupConfig("e2e-tr-special-quoting", {
      "find-dangerous": {
        description: "d",
        hook: "tool_result",
        // Look for a string that contains $() command-substitution
        shell: "grep -qF '$(rm -rf' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    const dangerous = "echo '$(rm -rf /)' should not appear in tool output";
    const event = makeReadResult(dangerous);

    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.strictEqual(result!.patch.isError, true);
  });

  // 7.19 ── special characters: tabs and unicode

  it("special characters (tabs, unicode) in result are preserved through env", async () => {
    const cwd = setupConfig("e2e-tr-special-tabs", {
      "find-tab": {
        description: "d",
        hook: "tool_result",
        // Tab-separated key-value
        shell: "grep -qF $'KEY\\tvalue' <<< \"$PI_TOOL_RESULT\" && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    const withTab = "line1\nKEY\tvalue\nline3 — em dash\nemoji: 🔑";
    const event = makeReadResult(withTab);

    const result = await executeToolResultAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.strictEqual(result!.patch.isError, true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// onRun callback (runtime visibility, tool_result)
// ═══════════════════════════════════════════════════════════════════

describe("e2e: tool_result onRun callback", () => {
  // R.1 ── onRun fires once per executed assert with correct fields ─

  it("onRun fires once per executed assert with name/hook/durationMs/passed", async () => {
    const cwd = setupConfig("e2e-tr-onrun-basic", {
      "passing-assert": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "true",
      },
      "failing-assert": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "false",
      },
      "skipped-by-filter": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "bash" },
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);
    const runs: RunRecord[] = [];

    // fail-fast stops at the first failing assert; in load order that's
    // passing-assert (runs), then failing-assert (runs + patches).
    await executeToolResultAsserts(
      asserts,
      makeReadResult("x"),
      defaultCtx,
      (r) => runs.push(r),
    );

    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs[0].name, "passing-assert");
    assert.strictEqual(runs[0].hook, "tool_result");
    assert.strictEqual(runs[0].passed, true);
    assert.ok(
      Number.isInteger(runs[0].durationMs) && runs[0].durationMs >= 0,
    );

    assert.strictEqual(runs[1].name, "failing-assert");
    assert.strictEqual(runs[1].hook, "tool_result");
    assert.strictEqual(runs[1].passed, false);
    assert.ok(
      Number.isInteger(runs[1].durationMs) && runs[1].durationMs >= 0,
    );
  });

  // R.2 ── Filter mismatch → onRun not called ─────────────────────

  it("onRun not called for filter mismatches", async () => {
    const cwd = setupConfig("e2e-tr-onrun-filter-miss", {
      "no-secrets-in-reads": {
        description: "d",
        hook: "tool_result",
        filter: { toolName: "read" },
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);
    const runs: RunRecord[] = [];

    // bash does not match { toolName: read }
    await executeToolResultAsserts(
      asserts,
      makeBashResult("SECRET=x"),
      defaultCtx,
      (r) => runs.push(r),
    );

    assert.strictEqual(runs.length, 0);
  });

  // R.3 ── when fails → onRun not called (shell never runs) ───────

  it("onRun not called when `when` fails (assert skipped)", async () => {
    const cwd = setupConfig("e2e-tr-onrun-when-fail", {
      "skipped": {
        description: "d",
        hook: "tool_result",
        when: "false",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);
    const runs: RunRecord[] = [];

    await executeToolResultAsserts(
      asserts,
      makeReadResult("x"),
      defaultCtx,
      (r) => runs.push(r),
    );

    assert.strictEqual(runs.length, 0);
  });

  // R.4 ── onRun called for passing asserts (visibility into passes) ─

  it("onRun fires for passing asserts (not just failures)", async () => {
    const cwd = setupConfig("e2e-tr-onrun-pass", {
      "always-ok": {
        description: "d",
        hook: "tool_result",
        shell: "true",
      },
    });

    const asserts = loadAsserts(cwd);
    const runs: RunRecord[] = [];

    await executeToolResultAsserts(
      asserts,
      makeReadResult("clean"),
      defaultCtx,
      (r) => runs.push(r),
    );

    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].passed, true);
  });

  // R.5 ── fail-fast stops onRun for later asserts ───────────────

  it("onRun not called for asserts after a fail-fast patch", async () => {
    const cwd = setupConfig("e2e-tr-onrun-failfast", {
      "blocker": {
        description: "d",
        hook: "tool_result",
        shell: "false",
      },
      "never-reached": {
        description: "d",
        hook: "tool_result",
        shell: "true",
      },
    });

    const asserts = loadAsserts(cwd);
    const runs: RunRecord[] = [];

    await executeToolResultAsserts(
      asserts,
      makeReadResult("x"),
      defaultCtx,
      (r) => runs.push(r),
    );

    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].name, "blocker");
    assert.strictEqual(runs[0].passed, false);
  });
});
