import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  loadAsserts,
  matchFilter,
  buildEnv,
  evaluateShell,
  type Assert,
} from "./engine.js";

export default function (pi: ExtensionAPI) {
  let asserts: Assert[] = [];

  // -----------------------------------------------------------------------
  // Load asserts on session start
  // -----------------------------------------------------------------------
  pi.on("session_start", (_event, ctx) => {
    asserts = loadAsserts(ctx.cwd);

    if (asserts.length > 0) {
      ctx.ui.notify(
        `pi-assert: ${asserts.length} assert${asserts.length === 1 ? "" : "s"} loaded`,
        "info",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Intercept tool calls
  // -----------------------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    for (const assert of asserts) {
      // Only handle tool_call hook for now (future: tool_result, etc.)
      if (assert.hook !== "tool_call") continue;

      // Skip if filter doesn't match
      if (!matchFilter(assert.filter, event)) continue;

      // Build env and run the shell command
      const env = buildEnv(event, ctx);
      const passed = await evaluateShell(assert.shell, env, ctx.signal);

      if (!passed) {
        const reason = `pi-assert: "${assert.name}" blocked ${event.toolName}`;

        if (ctx.hasUI) {
          ctx.ui.notify(reason, "error");
        }

        return { block: true, reason };
      }
    }
  });
}
