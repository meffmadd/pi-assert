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

// ---------------------------------------------------------------------------
// runAsserts — the shared control-flow core for all three hook executors.
//
// Every hook (tool_call / tool_result / agent_end) runs the same loop:
//   for each active assert matching the hook + filter:
//     build env → run optional `when` precondition (skip on non-zero) →
//     run `shell` → on failure, hand (assert, result) to `onFail`.
//
// The only things that differ between hooks are the candidate record, the
// env builder, and the failure policy.  `onFail` encodes the policy:
//   - return `{ value }` to stop and return that value (fail-fast, used by
//     tool_call and tool_result);
//   - return `"continue"` to keep scanning (agent_end collects every
//     failure into a closure-supplied array).
//
// Keeping the loop in one place means `when` handling, filter matching,
// and abort/timeout semantics only have to be fixed once.
// ---------------------------------------------------------------------------
type FailDecision<T> = "continue" | { value: T };

async function runAsserts<Evt, T>(
  asserts: Assert[],
  event: Evt,
  ctx: ExtensionContext,
  opts: {
    hook: string;
    candidate: Record<string, unknown>;
    buildEnv: (event: Evt, ctx: ExtensionContext) => Record<string, string>;
    onFail: (assert: Assert, result: ShellResult) => FailDecision<T>;
  },
): Promise<T | undefined> {
  for (const assert of asserts) {
    if (assert.hook !== opts.hook) continue;
    if (!matchFilter(assert.filter, opts.candidate)) continue;

    const env = opts.buildEnv(event, ctx);

    if (assert.when) {
      const precondition = await evaluateShell(assert.when, env, ctx.signal);
      if (!precondition.passed) continue;
    }

    const result = await evaluateShell(assert.shell, env, ctx.signal);

    if (!result.passed) {
      const decision = opts.onFail(assert, result);
      if (decision !== "continue") return decision.value;
    }
  }
  return undefined;
}

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
  return runAsserts(asserts, event, ctx, {
    hook: "tool_call",
    candidate: { toolName: event.toolName, ...event.input },
    buildEnv: buildEnv,
    onFail: (assert) => ({
      value: {
        block: true,
        reason: `pi-assert: assertion "${assert.name}" rejected ${event.toolName} — \`${assert.shell}\``,
      },
    }),
  });
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
  return runAsserts(asserts, event, ctx, {
    hook: "tool_result",
    candidate: { toolName: event.toolName, ...event.input },
    buildEnv: buildResultEnv,
    onFail: (assert) => ({
      value: {
        reason: `pi-assert: assertion "${assert.name}" blocked ${event.toolName} result — \`${assert.shell}\``,
        patch: {
          content: [
            {
              type: "text",
              text: `[BLOCKED by pi-assert] pi-assert: assertion "${assert.name}" blocked ${event.toolName} result — \`${assert.shell}\`\n\nThe original tool result was suppressed.`,
            },
          ],
          // Pass through details (when defined) so the patch is a complete
          // replacement. When event.details is undefined, the runner's
          // `!== undefined` check leaves the original details intact.
          details: event.details,
          isError: true,
        },
      },
    }),
  });
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
  // If the turn was interrupted, ctx.signal is already aborted and
  // evaluateShell would SIGTERM every assert (code null) before it runs —
  // reporting benign interrupts as spurious failures. Agent-end asserts
  // are informational (they don't block), so skip them on abort.
  if (ctx.signal?.aborted) return [];

  const failures: string[] = [];
  await runAsserts(asserts, event, ctx, {
    hook: "agent_end",
    candidate: { event: "agent_end" },
    buildEnv: buildAgentEndEnv,
    onFail: (assert, result) => {
      failures.push(
        `- **${assert.name}**: \`${assert.shell}\` (exit ${result.code})`,
      );
      return "continue";
    },
  });
  return failures;
}
