import {
  matchFilter,
  buildEnv,
  buildAgentEndEnv,
  evaluateShell,
  type Assert,
  type ShellResult,
  type AgentEndEvent,
  type ToolCallEvent,
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
