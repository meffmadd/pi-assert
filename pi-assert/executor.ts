import {
  matchFilter,
  buildEnv,
  buildAgentEndEnv,
  buildResultEnv,
  evaluateShell,
  isPreset,
  type Assert,
  type ShellAssert,
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

export interface AssertFailure {
  phase: "when" | "shell";
  command: string;
  result: ShellResult;
}

/**
 * A record of a single assert whose `shell` actually executed (filter
 * matched + `when` passed/absent). `when`-failed asserts are NOT recorded —
 * they never triggered the main shell.
 *
 * Used by `runAsserts`'s `onRun` side-channel to report runtime visibility
 * (which asserts ran and how long each took) without changing its return
 * type. `index.ts` collects these across hooks and reports once per prompt.
 */
export interface RunRecord {
  /** Assert name (for display). */
  name: string;
  /** Hook the assert ran under: "tool_call" | "tool_result" | "agent_end". */
  hook: string;
  /**
   * Wall-clock duration of the main `shell` execution in milliseconds
   * (excludes `when` time; when-skips record nothing).
   */
  durationMs: number;
  /** Whether the main `shell` passed (exit 0). */
  passed: boolean;
}

async function runAsserts<Evt, T>(
  asserts: Assert[],
  event: Evt,
  ctx: ExtensionContext,
  opts: {
    hook: string;
    candidate: Record<string, unknown>;
    buildEnv: (event: Evt, ctx: ExtensionContext) => Record<string, string>;
    onFail: (assert: ShellAssert, failure: AssertFailure) => FailDecision<T>;
    /** Called once per assert whose main `shell` executed, with its run record. */
    onRun?: (record: RunRecord) => void;
  },
): Promise<T | undefined> {
  for (const assert of asserts) {
    // Presets expand to shell asserts in `activeList()` and never reach here;
    // the guard is unreachable at runtime but narrows `assert` to `ShellAssert`
    // for the loop body (which reads `hook`/`filter`/`when`/`shell`).
    if (isPreset(assert)) continue;
    if (assert.hook !== opts.hook) continue;
    if (!matchFilter(assert.filter, opts.candidate)) continue;

    const env = opts.buildEnv(event, ctx);

    if (assert.when) {
      const precondition = await evaluateShell(assert.when, env, ctx.signal, undefined, ctx.cwd);
      // Non-zero means "not applicable"; null means timeout, abort, or a
      // spawn failure and must not bypass a guard.
      if (precondition.code === null) {
        const decision = opts.onFail(assert, {
          phase: "when",
          command: assert.when,
          result: precondition,
        });
        if (decision !== "continue") return decision.value;
        continue;
      }
      if (!precondition.passed) continue;
    }

    const t0 = Date.now();
    const result = await evaluateShell(assert.shell, env, ctx.signal, undefined, ctx.cwd);
    const elapsed = Date.now() - t0;
    opts.onRun?.({
      name: assert.name,
      hook: opts.hook,
      durationMs: elapsed,
      passed: result.passed,
    });

    if (!result.passed) {
      const decision = opts.onFail(assert, {
        phase: "shell",
        command: assert.shell,
        result,
      });
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
  onRun?: (record: RunRecord) => void,
): Promise<{ block: true; reason: string } | undefined> {
  return runAsserts(asserts, event, ctx, {
    hook: "tool_call",
    candidate: { ...event.input, toolName: event.toolName },
    buildEnv: buildEnv,
    onFail: (assert, failure) => ({
      value: {
        block: true,
        reason: failure.phase === "shell"
          ? `pi-assert: assertion "${assert.name}" rejected ${event.toolName} — \`${failure.command}\``
          : `pi-assert: assertion "${assert.name}" rejected ${event.toolName} during when — \`${failure.command}\``,
      },
    }),
    onRun,
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
  onRun?: (record: RunRecord) => void,
): Promise<{ patch: ToolResultPatch; reason: string } | undefined> {
  return runAsserts(asserts, event, ctx, {
    hook: "tool_result",
    candidate: { ...event.input, toolName: event.toolName },
    buildEnv: buildResultEnv,
    onFail: (assert, failure) => ({
      value: {
        reason: failure.phase === "shell"
          ? `pi-assert: assertion "${assert.name}" blocked ${event.toolName} result — \`${failure.command}\``
          : `pi-assert: assertion "${assert.name}" blocked ${event.toolName} result during when — \`${failure.command}\``,
        patch: {
          content: [
            {
              type: "text",
              text: failure.phase === "shell"
                ? `[BLOCKED by pi-assert] pi-assert: assertion "${assert.name}" blocked ${event.toolName} result — \`${failure.command}\`\n\nThe original tool result was suppressed.`
                : `[BLOCKED by pi-assert] pi-assert: assertion "${assert.name}" blocked ${event.toolName} result during when — \`${failure.command}\`\n\nThe original tool result was suppressed.`,
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
    onRun,
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
  onRun?: (record: RunRecord) => void,
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
    onFail: (assert, failure) => {
      failures.push(
        failure.phase === "shell"
          ? `- **${assert.name}**: \`${failure.command}\` (exit ${failure.result.code})`
          : `- **${assert.name}** (when): \`${failure.command}\` (exit ${failure.result.code})`,
      );
      return "continue";
    },
    onRun,
  });
  return failures;
}

/**
 * Format the per-hook runtime summary for the informational TUI toast.
 * Returns `""` for an empty list so the caller can skip emitting entirely
 * (no noise when no assert ran).
 *
 * One compact line — count + total wall-clock duration — so the toast stays
 * readable:
 *
 * ```
 * pi-assert ran 3 commands in 19ms
 * ```
 */
export function formatRunReport(runs: RunRecord[]): string {
  if (runs.length === 0) return "";
  const totalMs = runs.reduce((sum, r) => sum + r.durationMs, 0);
  return `pi-assert ran ${runs.length} command${runs.length === 1 ? "" : "s"} in ${totalMs}ms`;
}
