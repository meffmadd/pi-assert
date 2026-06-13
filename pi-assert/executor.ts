import {
  matchFilter,
  buildEnv,
  buildAgentEndEnv,
  buildResultEnv,
  evaluateShell,
  type Assert,
  type ShellResult,
  type AgentEndEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type ToolResultPatch,
  type ExtensionContext,
} from "./engine.js";

/**
 * Run active tool_call asserts against a single tool call.
 *
 * Returns the first block (fail-fast), or `undefined` if all pass.
 */
export async function executeToolCallAsserts(
  asserts: Assert[],
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
  const candidate: Record<string, unknown> = {
    toolName: event.toolName,
    ...event.input,
  };

  for (const assert of asserts) {
    if (assert.hook !== "tool_call") continue;
    if (!matchFilter(assert.filter, candidate)) continue;

    const env = buildEnv(event, ctx);

    if (assert.when) {
      const precondition: ShellResult = await evaluateShell(
        assert.when,
        env,
        ctx.signal,
      );
      if (!precondition.passed) continue;
    }

    const result: ShellResult = await evaluateShell(
      assert.shell,
      env,
      ctx.signal,
    );

    if (!result.passed) {
      const reason = `pi-assert: assertion "${assert.name}" rejected ${event.toolName} — \`${assert.shell}\``;
      return { block: true, reason };
    }
  }
  return undefined;
}

/**
 * Run active tool_result asserts against a single tool result.
 *
 * Returns a patch (replace content with a redacted message) and a reason
 * string when the first matching assert fails, or `undefined` if all pass.
 * The patch sets `isError: true` so the LLM sees a clear error rather than
 * silently hidden content.
 */
export async function executeToolResultAsserts(
  asserts: Assert[],
  event: ToolResultEvent,
  ctx: ExtensionContext,
): Promise<{ patch: ToolResultPatch; reason: string } | undefined> {
  const candidate: Record<string, unknown> = {
    toolName: event.toolName,
    ...event.input,
  };

  for (const assert of asserts) {
    if (assert.hook !== "tool_result") continue;
    if (!matchFilter(assert.filter, candidate)) continue;

    const env = buildResultEnv(event, ctx);

    if (assert.when) {
      const precondition: ShellResult = await evaluateShell(
        assert.when,
        env,
        ctx.signal,
      );
      if (!precondition.passed) continue;
    }

    const result: ShellResult = await evaluateShell(
      assert.shell,
      env,
      ctx.signal,
    );

    if (!result.passed) {
      const reason = `pi-assert: assertion "${assert.name}" blocked ${event.toolName} result — \`${assert.shell}\``;

      return {
        patch: {
          content: [
            {
              type: "text",
              text: `[BLOCKED by pi-assert] ${reason}\n\nThe original tool result was suppressed.`,
            },
          ],
          // Pass through details (when defined) so the patch is a complete
          // replacement. When event.details is undefined, the runner's
          // `!== undefined` check leaves the original details intact.
          details: event.details,
          isError: true,
        },
        reason,
      };
    }
  }
  return undefined;
}

/**
 * Run active agent_end asserts when the agent finishes a turn.
 *
 * Returns all failures (no fail-fast) so they can be reported together.
 */
export async function executeAgentEndAsserts(
  asserts: Assert[],
  event: AgentEndEvent,
  ctx: ExtensionContext,
): Promise<string[]> {
  const candidate: Record<string, unknown> = {
    event: "agent_end",
  };

  const failures: string[] = [];

  for (const assert of asserts) {
    if (assert.hook !== "agent_end") continue;
    if (!matchFilter(assert.filter, candidate)) continue;

    const env = buildAgentEndEnv(event, ctx);

    if (assert.when) {
      const precondition: ShellResult = await evaluateShell(
        assert.when,
        env,
        ctx.signal,
      );
      if (!precondition.passed) continue;
    }

    const result: ShellResult = await evaluateShell(
      assert.shell,
      env,
      ctx.signal,
    );

    if (!result.passed) {
      failures.push(
        `- **${assert.name}**: \`${assert.shell}\` (exit ${result.code})`,
      );
    }
  }

  return failures;
}
