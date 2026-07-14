import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AssertsParseError,
  isPreset,
  loadAsserts,
  type Assert,
  type LoadError,
} from "../engine.js";

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
    this.pi.appendEntry("pi-assert-config", {
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
        const data = entry.data as { activeAsserts?: string[] } | undefined;
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

  /** Remove every assert from the active set. */
  disableAll(): void {
    this.active.clear();
  }

  /** Toggle a named assert's active state. */
  toggle(name: string): void {
    if (this.active.has(name)) this.active.delete(name);
    else this.active.add(name);
  }

  /**
   * Return the asserts that should actually run: active shell asserts, plus
   * the shell-assert members of active presets (expanded, deduped).
   *
   * Single flat pass — no recursion, no cycles.  A preset referencing another
   * preset is a dangling ref to a preset and is skipped (no nested presets for
   * v1).  Dangling refs (a `source/name` that isn't installed) are silent at
   * runtime — they contribute nothing (same as empty); the `§` badge surfaces
   * it in the UI.  Dedup is by `source\x00name`, so an assert active both
   * individually and via a preset runs once.
   *
   * Refs split on the **last** `/`: `local/name` → source `local`, name
   * `name`; `owner/repo/name` → source `owner/repo`, name `name`.
   *
   * Only ever pushes non-preset members, so the result is effectively a
   * `ShellAssert[]` at runtime (typed `Assert[]` so `runAsserts` keeps its
   * `isPreset` guard for narrowing — see {@link runAsserts}).
   */
  activeList(): Assert[] {
    const byKey = new Map(
      this.asserts.map((a) => [`${a.source}\x00${a.name}`, a]),
    );
    const out: Assert[] = [];
    const seen = new Set<string>();
    for (const a of this.asserts) {
      if (!this.active.has(a.name)) continue;
      if (isPreset(a)) {
        for (const ref of a.preset) {
          const idx = ref.lastIndexOf("/"); // last "/", not first
          const member =
            idx >= 0
              ? byKey.get(ref.slice(0, idx) + "\x00" + ref.slice(idx + 1))
              : undefined;
          if (!member || isPreset(member)) continue; // dangling or nested → skip
          const key = `${member.source}\x00${member.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(member);
        }
      } else {
        const key = `${a.source}\x00${a.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(a);
        }
      }
    }
    return out;
  }
}
