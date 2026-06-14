import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AssertsParseError,
  loadAsserts,
  type Assert,
  type LoadError,
} from "../engine.js";

// ---------------------------------------------------------------------------
// Persistent state shape
// ---------------------------------------------------------------------------
export interface AssertsState {
  activeAsserts: string[];
}

// ---------------------------------------------------------------------------
// AssertsState — owns the model: loaded asserts, active set, persistence,
// and the status bar entry.
// ---------------------------------------------------------------------------
export class AssertsState {
  asserts: Assert[] = [];
  active: Set<string> = new Set();

  /**
   * `true` when the most recent `load()` failed to parse one or more
   * asserts.json files.  In that state, `asserts` is always empty and the
   * status bar shows an error indicator.
   */
  broken = false;

  /** Per-file parse errors from the most recent `load()`. Empty when healthy. */
  loadErrors: LoadError[] = [];

  constructor(private pi: ExtensionAPI) {}

  // ── Loading ────────────────────────────────────────────────────────
  /**
   * Reload asserts from disk for the given cwd.
   *
   * If parsing fails, swallows the `AssertsParseError`, sets `broken = true`,
   * clears `asserts`, and stores the per-file errors in `loadErrors`.  The
   * extension must not apply any asserts in that state.  Non-parse errors
   * (e.g. unexpected runtime issues) are re-thrown.
   */
  load(cwd: string): void {
    try {
      this.asserts = loadAsserts(cwd);
      this.broken = false;
      this.loadErrors = [];
    } catch (err) {
      if (err instanceof AssertsParseError) {
        this.asserts = [];
        this.active = new Set();
        this.broken = true;
        this.loadErrors = err.errors;
        return;
      }
      throw err;
    }
  }

  // ── Status bar ─────────────────────────────────────────────────────
  /** Update the "pi-assert" status bar entry. */
  updateStatus(ctx: ExtensionContext): void {
    const theme = ctx.ui.theme;

    if (this.broken) {
      const n = this.loadErrors.length;
      ctx.ui.setStatus(
        "pi-assert",
        theme.fg("error", `pi-assert: config error (${n} file${n === 1 ? "" : "s"})`),
      );
      return;
    }

    if (this.asserts.length === 0) {
      ctx.ui.setStatus("pi-assert", undefined);
      return;
    }
    const color = this.active.size > 0 ? "accent" : "dim";
    ctx.ui.setStatus(
      "pi-assert",
      theme.fg(color, `asserts: ${this.active.size}/${this.asserts.length}`),
    );
  }

  // ── Persistence ────────────────────────────────────────────────────
  /** Persist the current active set to the session branch. */
  persist(): void {
    this.pi.appendEntry<AssertsState>("pi-assert-config", {
      activeAsserts: Array.from(this.active),
    });
  }

  /**
   * Restore the active set from the current session branch.
   * Falls back to asserts flagged `default: true` if no saved state exists.
   */
  restore(ctx: ExtensionContext): void {
    const branchEntries = ctx.sessionManager.getBranch();
    let saved: string[] | undefined;

    for (const entry of branchEntries) {
      if (
        entry.type === "custom" &&
        entry.customType === "pi-assert-config"
      ) {
        const data = entry.data as AssertsState | undefined;
        if (data?.activeAsserts) {
          saved = data.activeAsserts;
        }
      }
    }

    if (saved) {
      // Restore saved selection (filter to asserts that still exist)
      const allNames = new Set(this.asserts.map((a) => a.name));
      this.active = new Set(saved.filter((n) => allNames.has(n)));
    } else {
      // No saved state — enable only asserts with default: true
      this.active = new Set(
        this.asserts.filter((a) => a.default).map((a) => a.name),
      );
    }
  }

  // ── Mutators ───────────────────────────────────────────────────────
  /** Add a named assert to the active set. */
  enable(name: string): void {
    this.active.add(name);
  }

  /** Remove a named assert from the active set. */
  disable(name: string): void {
    this.active.delete(name);
  }

  /** Toggle a named assert's active state. */
  toggle(name: string): void {
    if (this.active.has(name)) this.active.delete(name);
    else this.active.add(name);
  }

  /** Return the subset of asserts that are currently active. */
  activeList(): Assert[] {
    return this.asserts.filter((a) => this.active.has(a.name));
  }
}
