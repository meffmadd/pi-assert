/**
 * End-to-end tests: orchestration logic from index.ts exercised in isolation.
 *
 * These tests simulate the event loop that index.ts would run inside pi,
 * calling loadAsserts → matchFilter → buildEnv → evaluateShell in sequence.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadAsserts,
  matchFilter,
  buildEnv,
  evaluateShell,
  type Assert,
  type ToolCallEvent,
  type ExtensionContext,
} from "../pi-assert/engine.js";

// ── Simulated extension orchestration ──────────────────────────────

interface BlockResult {
  block: true;
  reason: string;
}

/**
 * Simulates what index.ts does: iterate asserts, match filter, run shell,
 * return first block or undefined.
 */
async function runAsserts(
  asserts: Assert[],
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<BlockResult | undefined> {
  for (const a of asserts) {
    if (a.hook !== "tool_call") continue;
    if (!matchFilter(a.filter, event)) continue;

    const env = buildEnv(event, ctx);

    // Precondition: if `when` is present and fails, skip this assert
    if (a.when) {
      const precondition = await evaluateShell(a.when, env, ctx.signal);
      if (!precondition.passed) continue;
    }

    const result = await evaluateShell(a.shell, env, ctx.signal);

    if (!result.passed) {
      const reason = `pi-assert: assertion "${a.name}" rejected ${event.toolName} — \`${a.shell}\``;
      return { block: true, reason };
    }
  }
  return undefined;
}

// ── Temp dir helpers ───────────────────────────────────────────────

let tmpRoot: string;
let savedHome: string | undefined;

function setupConfig(dir: string, json: object) {
  const d = join(tmpRoot, dir);
  mkdirSync(join(d, ".pi"), { recursive: true });
  // Wrap in local section for the new sectioned format
  writeFileSync(join(d, ".pi", "asserts.json"), JSON.stringify({ local: json }, null, 2));
  return d;
}

import { before, after } from "node:test";

before(() => {
  tmpRoot = join(tmpdir(), `pi-assert-e2e-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  // Isolate from user's real ~/.pi/asserts.json
  savedHome = process.env.HOME;
  process.env.HOME = tmpRoot;
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
});

// ── Shared context ─────────────────────────────────────────────────

const defaultCtx: ExtensionContext = { cwd: "/tmp" };

// ═══════════════════════════════════════════════════════════════════
// End-to-end scenarios
// ═══════════════════════════════════════════════════════════════════

describe("e2e: orchestration", () => {
  // 5.1 ── No asserts → all tools allowed ──────────────────────────

  it("no asserts loaded → all tools allowed", async () => {
    const cwd = setupConfig("e2e-empty", {});
    const asserts = loadAsserts(cwd);
    assert.strictEqual(asserts.length, 0);

    const events: ToolCallEvent[] = [
      { toolName: "write", toolCallId: "1", input: { path: "/f" } },
      { toolName: "bash", toolCallId: "2", input: { command: "rm -rf /" } },
      { toolName: "read", toolCallId: "3", input: { path: "/etc/passwd" } },
    ];

    for (const event of events) {
      const result = await runAsserts(asserts, event, defaultCtx);
      assert.strictEqual(result, undefined);
    }
  });

  // 5.2 ── Single assert, filter matches → block ───────────────────

  it("single assert with matching filter → block", async () => {
    const cwd = setupConfig("e2e-single-block", {
      "block-writes": {
        hook: "tool_call",
        filter: { toolName: "write" },
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);
    assert.strictEqual(asserts.length, 1);

    // write → matches filter, shell exits 1 → blocked
    const writeEvent: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c1",
      input: { path: "/f" },
    };
    const block = await runAsserts(asserts, writeEvent, defaultCtx);
    assert.ok(block);
    assert.strictEqual(block!.reason, 'pi-assert: assertion "block-writes" rejected write — `false`');

    // edit → filter doesn't match → allowed
    const editEvent: ToolCallEvent = {
      toolName: "edit",
      toolCallId: "c2",
      input: { path: "/f" },
    };
    const allowed = await runAsserts(asserts, editEvent, defaultCtx);
    assert.strictEqual(allowed, undefined);
  });

  // 5.3 ── Two asserts, first matches → fail-fast ──────────────────

  it("fail-fast: first matching assert blocks, second never runs", async () => {
    const cwd = setupConfig("e2e-failfast", {
      "block-all": {
        hook: "tool_call",
        filter: {},
        shell: "false",
      },
      "allow-read": {
        hook: "tool_call",
        filter: { toolName: "read" },
        shell: "true",
      },
    });

    const asserts = loadAsserts(cwd);
    assert.strictEqual(asserts.length, 2);

    // block-all is first, has no filter → always matches → blocks
    const readEvent: ToolCallEvent = {
      toolName: "read",
      toolCallId: "c3",
      input: { path: "/f" },
    };
    const block = await runAsserts(asserts, readEvent, defaultCtx);
    assert.ok(block);
    // It's blocked by "block-all", not "allow-read"
    assert.strictEqual(block!.reason, 'pi-assert: assertion "block-all" rejected read — `false`');
  });

  // 5.4 ── No filter → fires on every tool_call ────────────────────

  it("no filter → fires on every tool_call", async () => {
    const cwd = setupConfig("e2e-no-filter", {
      "block-everything": {
        hook: "tool_call",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    const eventTypes = ["write", "read", "edit", "bash", "custom_tool"];
    for (const toolName of eventTypes) {
      const event: ToolCallEvent = {
        toolName,
        toolCallId: "c",
        input: {},
      };
      const result = await runAsserts(asserts, event, defaultCtx);
      assert.ok(result, `${toolName} should be blocked`);
      assert.strictEqual(result!.reason, `pi-assert: assertion "block-everything" rejected ${toolName} — \`false\``);
    }
  });

  // 5.5 ── Filter on input field + shell checks content ────────────

  it("filter on input field + shell grep → only matching commands blocked", async () => {
    const cwd = setupConfig("e2e-content-check", {
      "no-delete-pods": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell: 'grep -q "kubectl.*delete.*pod" <<< "$PI_TOOL_INPUT" && exit 1 || exit 0',
      },
    });

    const asserts = loadAsserts(cwd);
    const ctx: ExtensionContext = { cwd: "/tmp" };

    // Should be blocked
    const blockEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c4",
      input: { command: "kubectl delete pod nginx" },
    };
    const block = await runAsserts(asserts, blockEvent, ctx);
    assert.ok(block);

    // Should be allowed
    const passEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c5",
      input: { command: "kubectl get pods" },
    };
    const pass = await runAsserts(asserts, passEvent, ctx);
    assert.strictEqual(pass, undefined);

    // Should be allowed (non-bash tool, filter fails)
    const writeEvent: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c6",
      input: { path: "/f" },
    };
    const writePass = await runAsserts(asserts, writeEvent, ctx);
    assert.strictEqual(writePass, undefined);
  });

  // 5.6 ── Assert with successful shell → allowed ──────────────────

  it("shell passes (exit 0) → tool allowed", async () => {
    const cwd = setupConfig("e2e-allow", {
      "allow-all": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell: "true",
      },
    });

    const asserts = loadAsserts(cwd);

    const event: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c7",
      input: { command: "anything" },
    };
    const result = await runAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 5.7 ── Multiple asserts with different hooks (future-proofing) ─

  it("asserts with non-tool_call hook are skipped", async () => {
    // Simulate what would happen if we had other hook types
    const asserts: Assert[] = [
      { name: "future-hook", source: "local", hook: "tool_result", filter: {}, shell: "false", default: false },
      { name: "blocker", source: "local", hook: "tool_call", filter: {}, shell: "true", default: false },
    ];

    const event: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c8",
      input: {},
    };

    // "future-hook" has hook "tool_result" → skipped
    // "blocker" has hook "tool_call", shell "true" → passes → allowed
    const result = await runAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 5.8 ── default-based activation ────────────────────────────────

  it("only asserts with default:true are active for new sessions", async () => {
    const cwd = setupConfig("e2e-defaults", {
      "always-active": {
        hook: "tool_call",
        filter: { toolName: "write" },
        shell: "false",
        default: true,
      },
      "opt-in": {
        hook: "tool_call",
        filter: { toolName: "bash" },
        shell: "false",
        default: false,
      },
      "also-opt-in": {
        hook: "tool_call",
        filter: { toolName: "read" },
        shell: "false",
      },
    });

    const allAsserts = loadAsserts(cwd);
    assert.strictEqual(allAsserts.length, 3);

    // Simulate index.ts restoreFromBranch logic (no saved state branch):
    // activeAsserts = new Set(asserts.filter(a => a.default).map(a => a.name))
    const activeAsserts = new Set(
      allAsserts.filter((a) => a.default).map((a) => a.name),
    );

    // Only "always-active" should be in the active set
    assert.strictEqual(activeAsserts.size, 1);
    assert.ok(activeAsserts.has("always-active"));
    assert.ok(!activeAsserts.has("opt-in"));
    assert.ok(!activeAsserts.has("also-opt-in"));

    // Only active asserts should run — simulate the tool_call loop
    const activeList = allAsserts.filter((a) => activeAsserts.has(a.name));
    assert.strictEqual(activeList.length, 1);

    const ctx: ExtensionContext = { cwd: "/tmp" };

    // write → blocked by "always-active" (default: true)
    const writeEvent: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c10",
      input: { path: "/f" },
    };
    const block = await runAsserts(activeList, writeEvent, ctx);
    assert.ok(block);
    assert.ok(block!.reason.includes("always-active"));

    // bash → not blocked ("opt-in" has default: false, not in active set)
    const bashEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c11",
      input: { command: "rm -rf /" },
    };
    const bashResult = await runAsserts(activeList, bashEvent, ctx);
    assert.strictEqual(bashResult, undefined);

    // read → not blocked ("also-opt-in" has no default, not in active set)
    const readEvent: ToolCallEvent = {
      toolName: "read",
      toolCallId: "c12",
      input: { path: "/etc/passwd" },
    };
    const readResult = await runAsserts(activeList, readEvent, ctx);
    assert.strictEqual(readResult, undefined);
  });

  // 5.10 ── when precondition: passes → main shell runs ─────────────

  it("when passes → main shell runs and can block", async () => {
    const cwd = setupConfig("e2e-when-pass", {
      "conditional-guard": {
        hook: "tool_call",
        when: "true",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    const event: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c13",
      input: { path: "/f" },
    };

    // when passes (true), shell runs (false) → blocked
    const result = await runAsserts(asserts, event, defaultCtx);
    assert.ok(result);
    assert.ok(result!.reason.includes("conditional-guard"));
  });

  it("when passes → main shell passes → allowed", async () => {
    const cwd = setupConfig("e2e-when-both-pass", {
      "always-ok": {
        hook: "tool_call",
        when: "true",
        shell: "true",
      },
    });

    const asserts = loadAsserts(cwd);

    const event: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c14",
      input: { path: "/f" },
    };

    // when passes, shell passes → allowed
    const result = await runAsserts(asserts, event, defaultCtx);
    assert.strictEqual(result, undefined);
  });

  // 5.11 ── when precondition: fails → assert skipped ───────────────

  it("when fails → assert skipped entirely (no block)", async () => {
    const cwd = setupConfig("e2e-when-fail", {
      "only-for-write": {
        hook: "tool_call",
        when: '[ "$PI_TOOL_NAME" = write ]',
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    // bash → when fails (PI_TOOL_NAME != write) → skipped, no block
    const bashEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c15",
      input: { command: "rm -rf /" },
    };
    const bashResult = await runAsserts(asserts, bashEvent, defaultCtx);
    assert.strictEqual(bashResult, undefined);

    // write → when passes → shell fails → blocked
    const writeEvent: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c16",
      input: { path: "/etc/hosts" },
    };
    const writeResult = await runAsserts(asserts, writeEvent, defaultCtx);
    assert.ok(writeResult);
    assert.ok(writeResult!.reason.includes("only-for-write"));
  });

  it("when fails → second assert still runs (fail-fast on main shell only)", async () => {
    const cwd = setupConfig("e2e-when-fail-continue", {
      "skip-on-bash": {
        hook: "tool_call",
        when: '[ "$PI_TOOL_NAME" = write ]',
        shell: "false",
      },
      "block-all": {
        hook: "tool_call",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    // bash → first assert: when fails → skipped
    //         second assert: no when, shell fails → blocked
    const bashEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c17",
      input: { command: "ls" },
    };
    const result = await runAsserts(asserts, bashEvent, defaultCtx);
    assert.ok(result);
    assert.ok(result!.reason.includes("block-all"));
  });

  // 5.12 ── when precondition: receives same env vars ────────────────

  it("when receives the same env vars as shell", async () => {
    const cwd = setupConfig("e2e-when-env", {
      "expensive-check": {
        hook: "tool_call",
        when: '[ "$PI_TOOL_NAME" = write ] && [ -n "$PI_TOOL_INPUT" ]',
        shell: "echo \"$PI_TOOL_INPUT\" | grep -q '\.env' && exit 1 || exit 0",
      },
    });

    const asserts = loadAsserts(cwd);

    // bash → when fails (PI_TOOL_NAME != write) → skipped
    const bashEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c18",
      input: { command: "cat .env" },
    };
    const bashResult = await runAsserts(asserts, bashEvent, defaultCtx);
    assert.strictEqual(bashResult, undefined);

    // write with safe path → when passes, shell passes → allowed
    const safeWrite: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c19",
      input: { path: "/src/app.ts" },
    };
    const safeResult = await runAsserts(asserts, safeWrite, defaultCtx);
    assert.strictEqual(safeResult, undefined);

    // write with .env path → when passes, shell fails → blocked
    const envWrite: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c20",
      input: { path: ".env" },
    };
    const envResult = await runAsserts(asserts, envWrite, defaultCtx);
    assert.ok(envResult);
    assert.ok(envResult!.reason.includes("expensive-check"));
  });

  // 5.13 ── filter and when → both must match before shell runs ──────

  it("assert with filter and when → both must match before shell runs", async () => {
    const cwd = setupConfig("e2e-filter-and-if", {
      "guard-write-env": {
        hook: "tool_call",
        filter: { toolName: "write" },
        when: "echo \"$PI_TOOL_INPUT\" | grep -q '\.env'",
        shell: "false",
      },
    });

    const asserts = loadAsserts(cwd);

    // bash → filter fails → skipped (never reaches when)
    const bashEvent: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c24",
      input: { command: "rm .env" },
    };
    assert.strictEqual(await runAsserts(asserts, bashEvent, defaultCtx), undefined);

    // write to safe path → filter passes, when fails → skipped
    const safeWrite: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c25",
      input: { path: "/src/app.ts" },
    };
    assert.strictEqual(await runAsserts(asserts, safeWrite, defaultCtx), undefined);

    // write to .env → filter passes, when passes, shell fails → blocked
    const envWrite: ToolCallEvent = {
      toolName: "write",
      toolCallId: "c26",
      input: { path: ".env" },
    };
    const blocked = await runAsserts(asserts, envWrite, defaultCtx);
    assert.ok(blocked);
    assert.ok(blocked!.reason.includes("guard-write-env"));
  });

  // 5.9 ── Signal propagation ──────────────────────────────────────

  it("ctx.signal aborts shell → blocked", async () => {
    const cwd = setupConfig("e2e-signal", {
      "slow-check": {
        hook: "tool_call",
        filter: {},
        shell: "sleep 10",
      },
    });

    const asserts = loadAsserts(cwd);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const ctx: ExtensionContext = { cwd: "/tmp", signal: controller.signal };

    const event: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "c9",
      input: {},
    };

    const result = await runAsserts(asserts, event, ctx);
    assert.ok(result);
    assert.ok(result!.reason.includes("slow-check"));
  });
});
