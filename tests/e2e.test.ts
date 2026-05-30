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
    const passed = await evaluateShell(a.shell, env, ctx.signal);

    if (!passed) {
      const reason = `pi-assert: "${a.name}" blocked ${event.toolName}`;
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
  writeFileSync(join(d, ".pi", "asserts.json"), JSON.stringify(json, null, 2));
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
    assert.strictEqual(block!.reason, 'pi-assert: "block-writes" blocked write');

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
    assert.strictEqual(block!.reason, 'pi-assert: "block-all" blocked read');
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
      assert.strictEqual(result!.reason, `pi-assert: "block-everything" blocked ${toolName}`);
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
      { name: "future-hook", hook: "tool_result", filter: {}, shell: "false" },
      { name: "blocker", hook: "tool_call", filter: {}, shell: "true" },
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

  // 5.8 ── Signal propagation ──────────────────────────────────────

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
