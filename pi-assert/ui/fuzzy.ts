/**
 * Pure fuzzy-match helpers for the `/asserts` panel search mode.
 *
 * No `Theme` / TUI deps so this is unit-testable in isolation.  The panel
 * calls `filterSection` once per section; `filterSection` routes every
 * field through `matchQuery` (the v1a → v1b seam), and `matchQuery` calls
 * the pure single-string matcher `fuzzyMatch`.
 *
 * See `fuzzy-search.md` for the full design.
 */

import type { Assert, ShellAssert, PresetAssert } from "../engine.js";

export interface FuzzyResult {
  /** Higher is better. Includes the per-field tier in `filterSection`. */
  score: number;
  /** Matched indices in the target (consumed by `highlightSegments`). */
  positions: number[];
}

// ── Scoring constants (adapted from fzf's `algo/algo.go` default scheme) ──
// fzf balances a per-char match bonus against a gap penalty that grows with
// the distance between consecutive matched chars — so a scattered
// subsequence (e.g. g…i…t across a long shell string) sinks below a tight one
// (e.g. `git-guard`). The 0-clamp eventually lets a path "die" so weak fields
// can be dropped entirely. The first pattern char's boundary bonus is
// doubled (its placement matters most).
const SCORE_MATCH = 16;              // per matched char
const SCORE_GAP_START = -3;          // opening a gap between matched chars
const SCORE_GAP_EXTENSION = -1;      // each extra char in that gap
const BONUS_BOUNDARY = 8;             // matched at a word boundary (after delim/space/-..)
const BONUS_CAMEL = 7;                // camelCase transition (lower→upper) — slightly less than boundary (no single-char gap)
const BONUS_CONSECUTIVE =             // contiguous chunk bonus — prevents the "foo-bar > foobar" anomaly
  -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2; // first pattern char's boundary bonus counts double

const BOUNDARY_CHARS = new Set(["_", "-", "/", ".", " ", ",", ":", ";", "|"]);
/** Fuzz scores are clamped below this so tier gaps (>= 10 000) dominate. */
const MAX_FUZZ = 9000;

/**
 * Pure case-insensitive subsequence match with lightweight scoring.
 * Returns `null` when `query` is not a subsequence of `target`.  Never
 * sees spaces in the query — callers normalize whitespace out first
 * (`matchQuery`), so this function is untouched by the v1a → v1b
 * (AND-of-tokens) upgrade.
 *
 * Score (then clamped to `MAX_FUZZ`) is the running path score, fzf-style:
 *  - per matched char: `+SCORE_MATCH` (+16)
 *  - **boundary** bonus `+BONUS_BOUNDARY` (8) when the char is at index 0 or
 *    preceded by a boundary char (`_ - / . , : ; | space`), `+BONUS_CAMEL` (7)
 *    at a camelCase transition (lowercase→uppercase).
 *  - **first-char multiplier**: the first pattern char's boundary bonus is
 *    doubled, since where the typed pattern *starts* carries the most weight
 *    (e.g. "to-go" vs "ongoing" on "og").
 *  - **contiguity bonus** `+BONUS_CONSECUTIVE` (4) per char adjacent to the
 *    previous match — keeps "foobar" outranking "foo-bar" on "foob".
 *  - **gap penalty** between consecutive matched chars:
 *    `SCORE_GAP_START + (gap-1)*SCORE_GAP_EXTENSION` (= `-3 - (gap-1)`). The
 *    accumulated bonus is cancelled once the gap grows past ~8 chars — this
 *    is what sinks scattered subsequence hits (the "too fuzzy" fix).
 *  - **0-clamp**: the running score never goes negative; once gaps have eaten
 *    all accumulated bonus the path is dead, and `filterSection` treats a
 *    `score === 0` field as a non-match.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, positions: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Greedy earliest subsequence.
  const positions: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q.charCodeAt(qi);
    let found = -1;
    while (ti < t.length) {
      if (t.charCodeAt(ti) === ch) {
        found = ti;
        ti++; // next search starts after this match
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    positions.push(found);
  }

  // Per-char accumulated path score (fzf V1-style greedy chain). Reads the
  // *original* target chars for boundary/camelCase detection, since matching
  // lowercases both sides but the actual case is what makes a boundary.
  let score = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;

    // Boundary bonus at this matched position.
    let bonus = 0;
    if (p === 0) {
      bonus = BONUS_BOUNDARY; // start-of-string is a word boundary
    } else {
      const prev = target.charCodeAt(p - 1)!;
      const cur = target.charCodeAt(p)!;
      const prevChar = target[p - 1]!;
      if (BOUNDARY_CHARS.has(prevChar)) {
        bonus = BONUS_BOUNDARY;
      } else if (
        prev >= 0x61 && prev <= 0x7a && cur >= 0x41 && cur <= 0x5a // camelCase
      ) {
        bonus = BONUS_CAMEL;
      }
    }
    // First pattern char's boundary bonus counts double.
    if (i === 0) bonus *= BONUS_FIRST_CHAR_MULTIPLIER;

    // Gap penalty between this match and the previous one. A gap of 0 →
    // contiguous chunk bonus; a gap > 0 → negative penalty that grows with
    // the gap so a scattered subsequence sinks.
    if (i > 0) {
      const gap = p - positions[i - 1]! - 1;
      if (gap === 0) {
        bonus += BONUS_CONSECUTIVE;
      } else {
        score += SCORE_GAP_START + (gap - 1) * SCORE_GAP_EXTENSION;
      }
    }

    score += SCORE_MATCH + bonus;
    // 0-clamp the running path: once gaps have cancelled all accumulated
    // bonus, the path is dead — filterSection treats score === 0 as a
    // non-match, scattering weak hits out of the results.
    if (score < 0) score = 0;
  }
  score = Math.min(MAX_FUZZ, score);
  return { score, positions };
}

/**
 * Query-normalized match — the v1a → v1b seam.
 *
 * v1a: spaces are ignored for matching (stripped), so `"no env"` matches
 * `"no-env"`; the display keeps the spaces verbatim.  Replacing this one
 * function with split-on-whitespace → every token must match (fzf-style
 * AND) is the entire v1b upgrade — `fuzzyMatch`, `filterSection`, and the
 * panel stay unchanged.
 */
export function matchQuery(query: string, target: string): FuzzyResult | null {
  return fuzzyMatch(query.replace(/\s+/g, ""), target);
}

export interface Segment {
  text: string;
  matched: boolean;
}

/**
 * Split `target` into matched/unmatched runs for `query`'s subsequence, for
 * rendering highlights.  Routes through `matchQuery` (same space-stripping,
 * same positions the ranker used) so a highlight is consistent with what
 * matched the assert: a field lights up iff it contributed to ranking.
 *
 * Returns `null` when there's no usable match — an empty/whitespace query,
 * a non-subsequence, or a `score === 0` dead path (which `filterSection`
 * also treats as a non-match) — so the caller renders the target plain.
 * Pure, no TUI deps; unit-testable alongside `fuzzyMatch`.
 */
export function highlightSegments(query: string, target: string): Segment[] | null {
  const m = matchQuery(query, target);
  if (!m || m.score === 0) return null;

  const matched = new Set(m.positions);
  const segs: Segment[] = [];
  let buf = "";
  let bufMatched = false;
  for (let i = 0; i < target.length; i++) {
    const isMatched = matched.has(i);
    if (i === 0) {
      buf = target[i]!;
      bufMatched = isMatched;
      continue;
    }
    if (isMatched === bufMatched) {
      buf += target[i]!;
    } else {
      segs.push({ text: buf, matched: bufMatched });
      buf = target[i]!;
      bufMatched = isMatched;
    }
  }
  if (buf.length > 0) segs.push({ text: buf, matched: bufMatched });
  return segs;
}

/** Per-field scorer config: which `Assert` field, and its dominance tier. */
const FIELDS: { field: keyof ShellAssert | keyof PresetAssert; tier: number }[] = [
  { field: "name", tier: 40_000 },
  { field: "description", tier: 30_000 },
  { field: "source", tier: 20_000 },
  { field: "shell", tier: 10_000 },
  { field: "when", tier: 10_000 },
];

export interface SectionMatch {
  assert: Assert;
  result: FuzzyResult;
}

/**
 * Filter + rank one section's asserts against a query, best-first.  Empty
 * (or all-whitespace) query short-circuits: every assert is returned with
 * score 0 in original within-section order.  On ties the sort is stable, so
 * original within-section order is preserved.
 *
 * Ranking is per-section by design — the panel calls this once per section
 * so section grouping and order stay stable while matches rank inside each
 * section.  An assert's overall score is the **max** across its fields
 * (`tier + fuzz`), so field dominance is deterministic: a `name` match
 * always outranks a `description` match, etc. (the fuzz score is clamped
 * far below the 10 000 tier gap). A field whose greedy path scored 0
 * (gap penalties ate all its bonus — a very scattered, low-quality hit)
 * contributes nothing: it is skipped so the assert can only rank via a
 * genuinely-matching field, or drop out entirely.
 */
export function filterSection(query: string, asserts: Assert[]): SectionMatch[] {
  const stripped = query.replace(/\s+/g, "");
  if (!stripped) {
    return asserts.map((assert) => ({
      assert,
      result: { score: 0, positions: [] } as FuzzyResult,
    }));
  }

  const ranked: SectionMatch[] = [];
  for (let i = 0; i < asserts.length; i++) {
    const a = asserts[i]!;
    let best: { score: number; positions: number[] } | null = null;
    for (const { field, tier } of FIELDS) {
      const value = (a as unknown as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.length === 0) continue;
      const m = matchQuery(stripped, value);
      if (!m || m.score === 0) continue;   // 0-clamp: dead path = no field match
      const score = tier + m.score;
      if (!best || score > best.score) {
        best = { score, positions: m.positions };
      }
    }
    if (!best) continue;
    ranked.push({
      assert: a,
      result: { score: best.score, positions: best.positions },
    });
  }

  // Stable sort by score descending; ties keep original within-section order.
  ranked.sort((x, y) => y.result.score - x.result.score);
  return ranked;
}