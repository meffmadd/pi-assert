/**
 * Tests for buildAgentEndEnv — environment variable construction for agent_end hooks.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAgentEndEnv, type AgentEndEvent, type ExtensionContext } from "../pi-assert/engine.js";

// ═══════════════════════════════════════════════════════════════════
// buildAgentEndEnv
// ═══════════════════════════════════════════════════════════════════

describe("buildAgentEndEnv", () => {
  // ── Basic env construction ─────────────────────────────────────

  it("builds correct env for agent_end", () => {
    const event: AgentEndEvent = {};
    const ctx: ExtensionContext = { cwd: "/home/user/project" };

    const env = buildAgentEndEnv(event, ctx);

    assert.strictEqual(env.PI_EVENT, "agent_end");
    assert.strictEqual(env.PI_CWD, "/home/user/project");
  });

  // ── Different CWD values ──────────────────────────────────────

  it("cwd flows from context correctly", () => {
    type Case = { cwd: string; expected: string };

    const cases: Case[] = [
      { cwd: "/home/user/project",       expected: "/home/user/project" },
      { cwd: "/tmp",                     expected: "/tmp" },
      { cwd: "/very/deep/nested/path",   expected: "/very/deep/nested/path" },
      { cwd: "relative/path",            expected: "relative/path" },
      { cwd: "",                         expected: "" },
    ];

    for (const { cwd: cwdValue, expected } of cases) {
      const c: ExtensionContext = { cwd: cwdValue };
      const event: AgentEndEvent = {};

      const env = buildAgentEndEnv(event, c);
      assert.strictEqual(env.PI_CWD, expected);
      assert.strictEqual(env.PI_EVENT, "agent_end");
    }
  });

  // ── Event is ignored (no fields used) ───────────────────────────

  it("ignores event contents — only ctx matters", () => {
    const event: AgentEndEvent = { /* any fields would be ignored */ };
    const ctx: ExtensionContext = { cwd: "/workspace" };

    const env = buildAgentEndEnv(event, ctx);
    assert.strictEqual(env.PI_EVENT, "agent_end");
    assert.strictEqual(env.PI_CWD, "/workspace");
  });
});
