/**
 * Tests for evaluateShell — shell command execution.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateShell } from "../pi-assert/engine.js";

// ── Shared env (minimal — merged over process.env) ────────────────

const env = { PI_TOOL_NAME: "bash" };

// ═══════════════════════════════════════════════════════════════════
// evaluateShell
// ═══════════════════════════════════════════════════════════════════

describe("evaluateShell", () => {
  // ── Exit codes ──────────────────────────────────────────────────

  describe("exit codes", () => {
    const cases: [string, string, boolean][] = [
      ['"true" → pass', "true", true],
      ['"false" → block', "false", false],
      ['"exit 0" → pass', "exit 0", true],
      ['"exit 1" → block', "exit 1", false],
      ['"exit 42" → block', "exit 42", false],
      ['"exit 255" → block', "exit 255", false],
    ];

    for (const [label, shell, expected] of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Shell features (pipes, redirects, chaining) ─────────────────

  describe("shell features", () => {
    const cases: [string, string, boolean][] = [
      // pipes
      ['pipe → match: echo hello | grep hello', "echo hello | grep hello", true],
      ['pipe → no match: echo hello | grep missing', "echo hello | grep missing", false],

      // &&
      ['"&&" both true → pass', "true && true", true],
      ['"&&" second fails → block', "true && false", false],
      ['"&&" first fails → block', "false && true", false],

      // ||
      ['"||" fallback → pass', "false || true", true],
      ['"||" both fail → block', "false || false", false],
      ['"||" first passes → pass', "true || false", true],

      // redirect
      ['redirect to /dev/null → pass', "echo hello > /dev/null", true],

      // combined
      ['"true && echo ok | grep ok" → pass', "true && echo ok | grep ok", true],
      ['"false || echo fallback | grep fallback" → pass', "false || echo fallback | grep fallback", true],
    ];

    for (const [label, shell, expected] of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Environment variable access ─────────────────────────────────

  describe("environment variable access", () => {
    const cases: [string, string, Record<string, string>, boolean][] = [
      ["can read PI_TOOL_NAME", '[ "$PI_TOOL_NAME" = bash ]', { PI_TOOL_NAME: "bash" }, true],
      ["non-matching PI_TOOL_NAME → block", '[ "$PI_TOOL_NAME" = write ]', { PI_TOOL_NAME: "bash" }, false],
      ["can grep PI_TOOL_INPUT", 'echo "$PI_TOOL_INPUT" | grep -q ls', { PI_TOOL_INPUT: '{"command":"ls -la"}' }, true],
      ["grep mismatch on PI_TOOL_INPUT → block", 'echo "$PI_TOOL_INPUT" | grep -q missing', { PI_TOOL_INPUT: '{"command":"ls -la"}' }, false],
      ["can read PI_CWD", '[ -n "$PI_CWD" ]', { PI_CWD: "/home/user/project" }, true],
    ];

    for (const [label, shell, vars, expected] of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, vars);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Signal cancellation ─────────────────────────────────────────

  describe("signal cancellation", () => {
    it("already-aborted signal → block (false)", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await evaluateShell("true", env, controller.signal);
      assert.strictEqual(result.passed, false);
    });

    it("aborted mid-execution → block (false)", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      const result = await evaluateShell("sleep 10", env, controller.signal, 5000);
      assert.strictEqual(result.passed, false);
    });

    it("no signal → normal exit code decides", async () => {
      assert.strictEqual((await evaluateShell("true", env)).passed, true);
      assert.strictEqual((await evaluateShell("false", env)).passed, false);
    });
  });

  // ── Timeout ─────────────────────────────────────────────────────

  describe("timeout", () => {
    const cases: [string, string, number | undefined, boolean][] = [
      ["command exceeds timeout → block", "sleep 10", 100, false],
      ["command finishes before timeout → pass", "true", 100, true],
      ["default timeout (5s) is enough for fast commands", "true", undefined, true],
    ];

    for (const [label, shell, timeoutMs, expected] of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env, undefined, timeoutMs);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Error paths ─────────────────────────────────────────────────

  describe("error paths", () => {
    const cases: [string, string, boolean][] = [
      ["command not found → block", "non_existent_command_xyz_123", false],
      ["syntax error in shell → block", "(", false],
    ];

    for (const [label, shell, expected] of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Env merges on top of process.env ────────────────────────────

  describe("env merges on top of process.env", () => {
    const cases: [string, string, Record<string, string>, boolean][] = [
      ["inherits PATH from process.env", "which true > /dev/null", {}, true],
      ["custom env overrides process.env for same key", '[ "$PI_TOOL_NAME" = custom_value ]', { PI_TOOL_NAME: "custom_value" }, true],
    ];

    for (const [label, shell, vars, expected] of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, vars);
        assert.strictEqual(result.passed, expected);
      });
    }
  });
});
