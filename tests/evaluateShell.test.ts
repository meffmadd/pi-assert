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
    type Case = { label: string; shell: string; expected: boolean };

    const cases: Case[] = [
      { label: '"true" → pass',      shell: "true",      expected: true },
      { label: '"false" → block',    shell: "false",     expected: false },
      { label: '"exit 0" → pass',    shell: "exit 0",    expected: true },
      { label: '"exit 1" → block',   shell: "exit 1",    expected: false },
      { label: '"exit 42" → block',  shell: "exit 42",   expected: false },
      { label: '"exit 255" → block', shell: "exit 255",  expected: false },
    ];

    for (const { label, shell, expected } of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Shell features (pipes, redirects, chaining) ─────────────────

  describe("shell features", () => {
    type Case = { label: string; shell: string; expected: boolean };

    const cases: Case[] = [
      // pipes
      { label: 'pipe → match: echo hello | grep hello',               shell: "echo hello | grep hello",               expected: true },
      { label: 'pipe → no match: echo hello | grep missing',          shell: "echo hello | grep missing",             expected: false },

      // &&
      { label: '"&&" both true → pass',                               shell: "true && true",                          expected: true },
      { label: '"&&" second fails → block',                           shell: "true && false",                         expected: false },
      { label: '"&&" first fails → block',                            shell: "false && true",                         expected: false },

      // ||
      { label: '"||" fallback → pass',                                shell: "false || true",                         expected: true },
      { label: '"||" both fail → block',                              shell: "false || false",                        expected: false },
      { label: '"||" first passes → pass',                            shell: "true || false",                         expected: true },

      // redirect
      { label: 'redirect to /dev/null → pass',                        shell: "echo hello > /dev/null",                expected: true },

      // combined
      { label: '"true && echo ok | grep ok" → pass',                  shell: "true && echo ok | grep ok",             expected: true },
      { label: '"false || echo fallback | grep fallback" → pass',     shell: "false || echo fallback | grep fallback", expected: true },
    ];

    for (const { label, shell, expected } of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Environment variable access ─────────────────────────────────

  describe("environment variable access", () => {
    type Case = { label: string; shell: string; vars: Record<string, string>; expected: boolean };

    const cases: Case[] = [
      { label: "can read PI_TOOL_NAME",                 shell: '[ "$PI_TOOL_NAME" = bash ]',      vars: { PI_TOOL_NAME: "bash" },                       expected: true },
      { label: "non-matching PI_TOOL_NAME → block",     shell: '[ "$PI_TOOL_NAME" = write ]',     vars: { PI_TOOL_NAME: "bash" },                       expected: false },
      { label: "can grep PI_TOOL_INPUT",                shell: 'echo "$PI_TOOL_INPUT" | grep -q ls', vars: { PI_TOOL_INPUT: '{"command":"ls -la"}' },    expected: true },
      { label: "grep mismatch on PI_TOOL_INPUT → block", shell: 'echo "$PI_TOOL_INPUT" | grep -q missing', vars: { PI_TOOL_INPUT: '{"command":"ls -la"}' }, expected: false },
      { label: "can read PI_CWD",                       shell: '[ -n "$PI_CWD" ]',                vars: { PI_CWD: "/home/user/project" },               expected: true },
    ];

    for (const { label, shell, vars, expected } of cases) {
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
    type Case = { label: string; shell: string; timeoutMs: number | undefined; expected: boolean };

    const cases: Case[] = [
      { label: "command exceeds timeout → block",                       shell: "sleep 10", timeoutMs: 100,        expected: false },
      { label: "command finishes before timeout → pass",                shell: "true",     timeoutMs: 100,        expected: true },
      { label: "default timeout (5s) is enough for fast commands",      shell: "true",     timeoutMs: undefined,  expected: true },
    ];

    for (const { label, shell, timeoutMs, expected } of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env, undefined, timeoutMs);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Error paths ─────────────────────────────────────────────────

  describe("error paths", () => {
    type Case = { label: string; shell: string; expected: boolean };

    const cases: Case[] = [
      { label: "command not found → block",        shell: "non_existent_command_xyz_123",  expected: false },
      { label: "syntax error in shell → block",    shell: "(",                             expected: false },
    ];

    for (const { label, shell, expected } of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, env);
        assert.strictEqual(result.passed, expected);
      });
    }
  });

  // ── Env merges on top of process.env ────────────────────────────

  describe("env merges on top of process.env", () => {
    type Case = { label: string; shell: string; vars: Record<string, string>; expected: boolean };

    const cases: Case[] = [
      { label: "inherits PATH from process.env",                   shell: "which true > /dev/null",                         vars: {},                                     expected: true },
      { label: "custom env overrides process.env for same key",    shell: '[ "$PI_TOOL_NAME" = custom_value ]',             vars: { PI_TOOL_NAME: "custom_value" },       expected: true },
    ];

    for (const { label, shell, vars, expected } of cases) {
      it(label, async () => {
        const result = await evaluateShell(shell, vars);
        assert.strictEqual(result.passed, expected);
      });
    }
  });
});
