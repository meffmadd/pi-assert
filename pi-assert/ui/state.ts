import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAsserts, type Assert } from "../engine.js";

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

  constructor(private pi: ExtensionAPI) {}

  // ── Loading ────────────────────────────────────────────────────────
  /** Reload asserts from disk for the given cwd. */
  load(cwd: string): void {
    this.asserts = loadAsserts(cwd);
  }

  // ── Status bar ─────────────────────────────────────────────────────
  /** Update the "pi-assert" status bar entry. */
  updateStatus(ctx: ExtensionContext): void {
    if (this.asserts.length === 0) {
      ctx.ui.setStatus("pi-assert", undefined);
      return;
    }
    const theme = ctx.ui.theme;
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
