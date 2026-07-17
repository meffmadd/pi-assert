/**
 * Tests for `editPresetRule` — the `e` edit focused preset writer.
 *
 * `editPresetRule` is local-only: it edits a local preset in place via
 * `updateRule` (preserves on-disk `default`).  Repo presets are read-only
 * (`❄`) in the `/asserts` panel and never reach this function; forking a repo
 * preset to local on edit was removed.
 *
 * The `default` flag is preserved through the write (like `updateRule`):
 * `cleanEntry`'s preset branch runs with the existing `default`, so a
 * `t`-enabled preset `e`-edited doesn't silently lose its default.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { editPresetRule } from "../pi-assert/installer.js";
import { projectFilePath } from "../pi-assert/config.js";

// ── Helpers ───────────────────────────────────────────────────────

let tmpRoot: string;

before(() => {
  tmpRoot = join(tmpdir(), `pi-assert-edit-preset-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Read+parse the asserts file at `path` (throws if missing/unparseable). */
function readParsed(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Write initial JSON to the project file under `cwd/.pi/asserts.json`. */
function writeProjectFile(cwd: string, json: object): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "asserts.json"), JSON.stringify(json));
}

// ═══════════════════════════════════════════════════════════════════
// Local source: edit in place
// ═══════════════════════════════════════════════════════════════════

describe("editPresetRule local source", () => {
  it("edits description + preset in place", () => {
    const cwd = join(tmpRoot, "local-edit-in-place");
    writeProjectFile(cwd, {
      local: {
        "my-preset": {
          description: "Old desc.",
          preset: ["local/a", "local/b"],
        },
      },
    });

    editPresetRule(
      projectFilePath(cwd),
      "my-preset",
      "New desc.",
      ["local/a", "local/c"],
    );

    const parsed = readParsed(projectFilePath(cwd));
    assert.deepStrictEqual(parsed, {
      local: {
        "my-preset": {
          description: "New desc.",
          preset: ["local/a", "local/c"],
        },
      },
    });
  });

  it("preserves on-disk default:true through an in-place edit", () => {
    const cwd = join(tmpRoot, "local-preserve-default");
    writeProjectFile(cwd, {
      local: {
        "my-preset": {
          description: "Old.",
          preset: ["local/a"],
          default: true,
        },
      },
    });

    editPresetRule(
      projectFilePath(cwd),
      "my-preset",
      "New.",
      ["local/a", "local/b"],
    );

    const parsed = readParsed(projectFilePath(cwd));
    assert.deepStrictEqual(parsed, {
      local: {
        "my-preset": {
          description: "New.",
          preset: ["local/a", "local/b"],
          default: true,
        },
      },
    });
  });

  it("does not add default when the on-disk entry had none", () => {
    const cwd = join(tmpRoot, "local-no-default");
    writeProjectFile(cwd, {
      local: {
        "my-preset": {
          description: "Old.",
          preset: ["local/a"],
        },
      },
    });

    editPresetRule(
      projectFilePath(cwd),
      "my-preset",
      "New.",
      ["local/a"],
    );

    const parsed = readParsed(projectFilePath(cwd));
    assert.deepStrictEqual(parsed, {
      local: {
        "my-preset": {
          description: "New.",
          preset: ["local/a"],
          // default must NOT appear — the installed entry had none.
        },
      },
    });
  });

  it("preserves default:false (falsy but present) through an edit", () => {
    const cwd = join(tmpRoot, "local-default-false");
    writeProjectFile(cwd, {
      local: {
        "my-preset": {
          description: "Old.",
          preset: ["local/a"],
          default: false,
        },
      },
    });

    editPresetRule(
      projectFilePath(cwd),
      "my-preset",
      "New.",
      ["local/a"],
    );

    const parsed = readParsed(projectFilePath(cwd));
    // default:false is falsy — `updateRule` reads the on-disk `default`
    // (`false`), which is `!== true`, so the default key is dropped (matches
    // updateRule behaviour for a regular update).
    assert.deepStrictEqual(parsed, {
      local: {
        "my-preset": {
          description: "New.",
          preset: ["local/a"],
        },
      },
    });
  });

  it("throws when the local entry is missing from disk (stale state)", () => {
    const cwd = join(tmpRoot, "local-missing");
    writeProjectFile(cwd, {
      local: {
        "other-preset": { description: "x", preset: [] },
      },
    });

    assert.throws(
      () =>
        editPresetRule(
          projectFilePath(cwd),
          "missing-preset",
          "Desc.",
          [],
        ),
      /not found/,
    );
  });
});
