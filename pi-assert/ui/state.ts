import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AssertsParseError,
  isPreset,
  loadAsserts,
  type Assert,
  type LoadError,
} from "../engine.js";
import { entryKey } from "../config.js";

// ---------------------------------------------------------------------------
// Preset resolution — shared by active execution and panel coverage.
// ---------------------------------------------------------------------------
/** Resolve one level of a preset to installed shell asserts, in ref order. */
export function resolvePresetMembers(asserts: Assert[], preset: Assert): Assert[] {
  if (!isPreset(preset)) return [];
  const byKey = new Map(asserts.map((a) => [entryKey(a.source, a.name), a]));
  const members: Assert[] = [];
  for (const ref of preset.preset) {
    const idx = ref.lastIndexOf("/");
    const member = idx >= 0
      ? byKey.get(entryKey(ref.slice(0, idx), ref.slice(idx + 1)))
      : undefined;
    if (member && !isPreset(member)) members.push(member);
  }
  return members;
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
  /** Canonical, source-qualified key for an entry. */
  keyOf(a: Assert): string {
    return entryKey(a.source, a.name);
  }

  /** Whether this entry is enabled. Legacy bare names only match uniquely. */
  isActive(a: Assert): boolean {
    const key = this.keyOf(a);
    if (this.active.has(key)) return true;
    // Backward compatibility for old session entries and hand-built state in
    // extensions/tests. Never let a bare name enable colliding entries.
    return this.active.has(a.name) &&
      this.asserts.filter((other) => other.name === a.name).length === 1;
  }

  private resolveKey(value: Assert | string): string {
    if (typeof value !== "string") return this.keyOf(value);
    if (value.includes("\x00")) return value;
    const matches = this.asserts.filter((a) => a.name === value);
    return matches.length === 1 ? this.keyOf(matches[0]!) : value;
  }

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
      // Saved v2 entries are source-qualified. Explicitly migrate old bare
      // names only when they identify exactly one loaded entry; ambiguous old
      // entries are dropped rather than enabling every collision.
      const valid = new Set(this.asserts.map((a) => this.keyOf(a)));
      const migrated = saved.flatMap((value) => {
        if (value.includes("\x00")) return valid.has(value) ? [value] : [];
        const matches = this.asserts.filter((a) => a.name === value);
        return matches.length === 1 ? [this.keyOf(matches[0]!)] : [];
      });
      this.active = new Set(migrated);
    } else {
      // No saved state — enable only asserts with default: true
      this.active = new Set(
        this.asserts.filter((a) => a.default).map((a) => this.keyOf(a)),
      );
    }
  }

  // ── Mutators ───────────────────────────────────────────────────────
  /** Add a named assert to the active set. */
  enable(assert: Assert | string): void {
    this.active.add(this.resolveKey(assert));
  }

  /** Remove an assert from the active set. */
  disable(assert: Assert | string): void {
    this.active.delete(this.resolveKey(assert));
  }

  /** Remove every assert from the active set. */
  disableAll(): void {
    this.active.clear();
  }

  /** Toggle a named assert's active state. */
  toggle(assert: Assert | string): void {
    const key = this.resolveKey(assert);
    if (this.active.has(key)) this.active.delete(key);
    else this.active.add(key);
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
    const out: Assert[] = [];
    const seen = new Set<string>();
    for (const a of this.asserts) {
      if (!this.isActive(a)) continue;
      if (isPreset(a)) {
        for (const member of resolvePresetMembers(this.asserts, a)) {
          const key = this.keyOf(member);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(member);
        }
      } else {
        const key = this.keyOf(a);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(a);
        }
      }
    }
    return out;
  }
}
