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
  // 4.1 ── Exit codes ──────────────────────────────────────────────

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
        assert.strictEqual(result, expected);
      });
    }
  });

  // 4.2 ── Shell features (pipes, redirects, chaining) ─────────────

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
        assert.strictEqual(result, expected);
      });
    }
  });

  // 4.3 ── Environment variable access ─────────────────────────────

  describe("environment variable access", () => {
    it("can read PI_TOOL_NAME from env", async () => {
      // [ "$PI_TOOL_NAME" = bash ] → exit 0 if match
      const result = await evaluateShell(
        '[ "$PI_TOOL_NAME" = bash ]',
        { PI_TOOL_NAME: "bash" },
      );
      assert.strictEqual(result, true);
    });

    it("non-matching PI_TOOL_NAME → block", async () => {
      const result = await evaluateShell(
        '[ "$PI_TOOL_NAME" = write ]',
        { PI_TOOL_NAME: "bash" },
      );
      assert.strictEqual(result, false);
    });

    it("can grep PI_TOOL_INPUT", async () => {
      const result = await evaluateShell(
        'echo "$PI_TOOL_INPUT" | grep -q ls',
        { PI_TOOL_INPUT: '{"command":"ls -la"}' },
      );
      assert.strictEqual(result, true);
    });

    it("grep mismatch on PI_TOOL_INPUT → block", async () => {
      const result = await evaluateShell(
        'echo "$PI_TOOL_INPUT" | grep -q missing',
        { PI_TOOL_INPUT: '{"command":"ls -la"}' },
      );
      assert.strictEqual(result, false);
    });

    it("can read PI_CWD", async () => {
      const result = await evaluateShell(
        '[ -n "$PI_CWD" ]',
        { PI_CWD: "/home/user/project" },
      );
      assert.strictEqual(result, true);
    });
  });

  // 4.4 ── Signal cancellation ─────────────────────────────────────

  describe("signal cancellation", () => {
    it("already-aborted signal → block (false)", async () => {
      const controller = new AbortController();
      controller.abort(); // abort before passing

      const result = await evaluateShell("true", env, controller.signal);
      assert.strictEqual(result, false);
    });

    it("aborted mid-execution → block (false)", async () => {
      const controller = new AbortController();

      // Abort after a short delay while sleep is running
      setTimeout(() => controller.abort(), 50);

      const result = await evaluateShell("sleep 10", env, controller.signal, 5000);
      assert.strictEqual(result, false);
    });

    it("no signal → normal exit code decides", async () => {
      const result = await evaluateShell("true", env);
      assert.strictEqual(result, true);

      const result2 = await evaluateShell("false", env);
      assert.strictEqual(result2, false);
    });
  });

  // 4.5 ── Timeout ─────────────────────────────────────────────────

  describe("timeout", () => {
    it("command exceeds timeout → block (false)", async () => {
      const result = await evaluateShell("sleep 10", env, undefined, 100);
      assert.strictEqual(result, false);
    });

    it("command finishes before timeout → pass", async () => {
      const result = await evaluateShell("true", env, undefined, 100);
      assert.strictEqual(result, true);
    });

    it("default timeout is generous enough for fast commands", async () => {
      // Default is 5000ms — "true" finishes instantly
      const result = await evaluateShell("true", env);
      assert.strictEqual(result, true);
    });
  });

  // 4.6 ── Command not found / error paths ─────────────────────────

  describe("error paths", () => {
    it("command not found → block (false)", async () => {
      const result = await evaluateShell(
        "non_existent_command_xyz_123",
        env,
      );
      assert.strictEqual(result, false);
    });

    it("syntax error in shell → block (false)", async () => {
      const result = await evaluateShell("(", env);
      assert.strictEqual(result, false);
    });
  });

  // 4.7 ── Env merges on top of process.env ────────────────────────

  describe("env merges on top of process.env", () => {
    it("inherits PATH from process.env", async () => {
      // `which true` should find /usr/bin/true or /bin/true
      const result = await evaluateShell("which true > /dev/null", env);
      assert.strictEqual(result, true);
    });

    it("custom env overrides process.env for same key", async () => {
      // We set PI_TOOL_NAME to a custom value
      const result = await evaluateShell(
        '[ "$PI_TOOL_NAME" = custom_value ]',
        { PI_TOOL_NAME: "custom_value" },
      );
      assert.strictEqual(result, true);
    });
  });
});
