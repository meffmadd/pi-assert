import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssertsState } from "./ui/state.js";
import { registerAssertsCommand } from "./ui/asserts.js";
import {
  executeAgentEndAsserts,
  executeToolCallAsserts,
  executeToolResultAsserts,
} from "./executor.js";
import type { AgentEndEvent, ToolResultEvent } from "./engine.js";

// ---------------------------------------------------------------------------
// pi-assert extension entry point.
//
// This file is intentionally thin: it owns the lifecycle wiring (session
// start, session tree, hook events) and delegates everything else to the
// `ui/` modules.
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  const state = new AssertsState(pi);

  // ── Load asserts on session start ─────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    state.load(ctx.cwd);

    // Hard-fail: if either asserts.json file failed to parse, do NOT restore
    // any active set, do NOT install any asserts, and tell the user.
    if (state.broken) {
      const n = state.loadErrors.length;
      const details = state.loadErrors
        .map((e) => `  • ${e.path}: ${e.reason}`)
        .join("\n");
      ctx.ui.notify(
        `pi-assert: failed to parse ${n} config file${n === 1 ? "" : "s"}; no asserts are active.\n${details}`,
        "error",
      );
      state.updateStatus(ctx);
      return;
    }

    state.restore(ctx);
    state.updateStatus(ctx);

    if (state.asserts.length > 0) {
      ctx.ui.notify(
        `pi-assert: ${state.asserts.length} assert${state.asserts.length === 1 ? "" : "s"} loaded (${state.active.size} active)`,
        "info",
      );
    }
  });

  // ── Restore state when navigating the session tree ────────────────
  pi.on("session_tree", (_event, ctx) => {
    state.restore(ctx);
    state.updateStatus(ctx);
  });

  // ── /asserts command ──────────────────────────────────────────────
  registerAssertsCommand(pi, state);

  // ── Intercept tool calls ──────────────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const result = await executeToolCallAsserts(
      state.activeList(),
      event,
      ctx,
    );

    if (result) {
      if (ctx.hasUI) {
        ctx.ui.notify(result.reason, "error");
      }
      return result;
    }
  });

  // ── Intercept tool results (patch content on failure) ─────────────
  pi.on("tool_result", async (event, ctx) => {
    const resultEvent = event as unknown as ToolResultEvent;
    const result = await executeToolResultAsserts(
      state.activeList(),
      resultEvent,
      ctx,
    );

    if (result) {
      if (ctx.hasUI) {
        ctx.ui.notify(result.reason, "error");
      }
      return result.patch;
    }
  });

  // ── Agent-end asserts ─────────────────────────────────────────────
  pi.on("agent_end", async (event, ctx) => {
    const agentEndEvent = event as unknown as AgentEndEvent;
    const failures = await executeAgentEndAsserts(
      state.activeList(),
      agentEndEvent,
      ctx,
    );

    if (failures.length === 0) return;

    const body =
      `${failures.length} assertion${failures.length === 1 ? "" : "s"} failed after your last turn:\n\n` +
      failures.join("\n");

    if (ctx.hasUI) {
      ctx.ui.notify(
        `pi-assert: ${failures.length} agent_end assertion${failures.length === 1 ? "" : "s"} failed`,
        "warning",
      );
    }

    pi.sendMessage(
      {
        customType: "pi-assert",
        content: body,
        display: true,
      },
      { triggerTurn: true },
    );
  });
}
