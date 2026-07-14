/**
 * Tests for config.ts — the single owner of the on-disk asserts.json format
 * (section identification + entry-shape validation), shared by the runtime
 * loader (engine.ts) and the installer (installer.ts).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  iterSections,
  projectFilePath,
  readSectionedFile,
  REF_RE,
  validateEntryShape,
  validatePresetShape,
  validateRuleEntry,
  writeSectionedFile,
  type SectionedFile,
} from "../pi-assert/config.js";

let tmpRoot: string;

before(() => {
  tmpRoot = join(tmpdir(), `pi-assert-config-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
  const path = join(tmpRoot, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// validateEntryShape
// ---------------------------------------------------------------------------

describe("validateEntryShape", () => {
  it("accepts an entry with description + hook + shell", () => {
    assert.ok(validateEntryShape({ description: "d", hook: "tool_call", shell: "false" }));
  });

  it("accepts an entry with all optional fields", () => {
    assert.ok(
      validateEntryShape({
        description: "d",
        hook: "tool_call",
        filter: { toolName: "bash" },
        when: "true",
        shell: "false",
        default: true,
      }),
    );
  });

  it("rejects entries missing description", () => {
    assert.ok(!validateEntryShape({ hook: "tool_call", shell: "false" }));
  });

  it("rejects non-string description", () => {
    assert.ok(
      !validateEntryShape({ description: 5, hook: "tool_call", shell: "false" }),
    );
  });

  it("rejects entries missing hook", () => {
    assert.ok(!validateEntryShape({ description: "d", shell: "false" }));
  });

  it("rejects entries missing shell", () => {
    assert.ok(!validateEntryShape({ description: "d", hook: "tool_call" }));
  });

  it("rejects non-object entries", () => {
    assert.ok(!validateEntryShape(null));
    assert.ok(!validateEntryShape("string"));
    assert.ok(!validateEntryShape(42));
  });

  it("requires description (on-disk and rule-repo entries)", () => {
    assert.ok(!validateEntryShape({ hook: "tool_call", shell: "false" }));
    assert.ok(
      validateEntryShape({ description: "d", hook: "tool_call", shell: "false" }),
    );
  });
});

// ---------------------------------------------------------------------------
// iterSections
// ---------------------------------------------------------------------------

describe("iterSections", () => {
  it("skips metadata keys ($schema, repos)", () => {
    const file: SectionedFile = {
      $schema: "https://example.com/schema.json",
      repos: ["owner/repo"],
      local: { a: { hook: "tool_call", shell: "true" } },
    };
    const sections = iterSections(file);
    assert.deepEqual(
      sections.map((s) => s.source),
      ["local"],
    );
  });

  it("skips non-object top-level values", () => {
    const file = {
      local: { a: { hook: "tool_call", shell: "true" } },
      bad: "not an object",
      alsoBad: 42,
      ok: { b: { hook: "tool_call", shell: "false" } },
    } as unknown as SectionedFile;
    const sources = iterSections(file).map((s) => s.source);
    assert.deepEqual(sources, ["local", "ok"]);
  });

  it("yields every object section when knownRepos is omitted (backward compat)", () => {
    const file = {
      local: { a: { hook: "tool_call", shell: "true" } },
      "owner/repo": { b: { hook: "tool_call", shell: "false" } },
      "other/repo": { c: { hook: "tool_call", shell: "false" } },
    } as unknown as SectionedFile;
    const sources = iterSections(file).map((s) => s.source);
    assert.deepEqual(sources, ["local", "owner/repo", "other/repo"]);
  });

  it("filters to knownRepos when provided (including local)", () => {
    const file = {
      local: { a: { hook: "tool_call", shell: "true" } },
      "owner/repo": { b: { hook: "tool_call", shell: "false" } },
      "unknown/repo": { c: { hook: "tool_call", shell: "false" } },
    } as unknown as SectionedFile;
    const known = new Set(["local", "owner/repo"]);
    const sources = iterSections(file, known).map((s) => s.source);
    assert.deepEqual(sources, ["local", "owner/repo"]);
  });

  it("preserves insertion order", () => {
    const file = {
      "z/repo": { a: { hook: "tool_call", shell: "true" } },
      local: { b: { hook: "tool_call", shell: "true" } },
      "a/repo": { c: { hook: "tool_call", shell: "true" } },
    } as unknown as SectionedFile;
    const sources = iterSections(file).map((s) => s.source);
    assert.deepEqual(sources, ["z/repo", "local", "a/repo"]);
  });

  it("returns entries by reference so callers can mutate in place", () => {
    const file: SectionedFile = {
      local: { a: { hook: "tool_call", shell: "true" } },
    };
    const [{ entries }] = iterSections(file);
    entries.a!.hook = "tool_result";
    assert.equal((file.local as Record<string, unknown>).a.hook, "tool_result");
  });
});

// ---------------------------------------------------------------------------
// readSectionedFile / writeSectionedFile / projectFilePath
// ---------------------------------------------------------------------------

describe("readSectionedFile", () => {
  it("returns {} when the file is missing", () => {
    assert.deepEqual(readSectionedFile(join(tmpRoot, "nope.json")), {});
  });

  it("parses a valid JSON object file", () => {
    const path = writeTmp("valid.json", JSON.stringify({ repos: ["a/b"], local: {} }));
    const file = readSectionedFile(path);
    assert.deepEqual(file.repos, ["a/b"]);
  });

  it("throws on unparseable JSON (runtime loader relies on this)", () => {
    const path = writeTmp("broken.json", "{not json");
    assert.throws(() => readSectionedFile(path));
  });

  it("does not throw on non-object JSON (arrays yield no sections, matching runtime)", () => {
    const path = writeTmp("array.json", "[1,2,3]");
    const file = readSectionedFile(path);
    // iterSections skips non-object top-level values, so an array yields [].
    assert.deepEqual(iterSections(file), []);
  });
});

describe("writeSectionedFile", () => {
  it("creates parent directories and writes pretty JSON + trailing newline", () => {
    const path = join(tmpRoot, "sub", "dir", "out.json");
    writeSectionedFile(path, { local: { a: { hook: "tool_call", shell: "true" } } });
    const file = readSectionedFile(path);
    assert.ok(file.local);
  });

  it("round-trips through readSectionedFile", () => {
    const path = join(tmpRoot, "roundtrip.json");
    const data: SectionedFile = {
      $schema: "x",
      repos: ["a/b"],
      local: { r: { hook: "tool_call", shell: "false", default: true } },
      "a/b": { r2: { hook: "tool_call", shell: "true" } },
    };
    writeSectionedFile(path, data);
    assert.deepEqual(readSectionedFile(path), data);
  });
});

describe("projectFilePath", () => {
  it("resolves <cwd>/.pi/asserts.json", () => {
    assert.equal(projectFilePath("/tmp/proj"), join("/tmp/proj", ".pi", "asserts.json"));
  });
});

// ---------------------------------------------------------------------------
// REF_RE — preset ref source-shape enforcement
// ---------------------------------------------------------------------------

describe("REF_RE", () => {
  it("accepts local/name", () => {
    assert.ok(REF_RE.test("local/block-rm-rf"));
  });

  it("accepts owner/repo/name", () => {
    assert.ok(REF_RE.test("meffmadd/pi-assert-rules/protect-env"));
  });

  it("rejects a bare owner/name (always-dangling: source 'owner' isn't a section)", () => {
    assert.ok(!REF_RE.test("meffmadd/pi-assert-rules"));
  });

  it("rejects local/a/b (always-dangling: source 'local/a')", () => {
    assert.ok(!REF_RE.test("local/a/b"));
  });

  it("rejects a bare name (no slash)", () => {
    assert.ok(!REF_RE.test("block-rm-rf"));
  });
});

// ---------------------------------------------------------------------------
// validatePresetShape
// ---------------------------------------------------------------------------

describe("validatePresetShape", () => {
  it("accepts a preset with description + preset refs", () => {
    assert.ok(
      validatePresetShape({
        description: "Block destructive writes",
        preset: ["local/block-rm-rf", "meffmadd/pi-assert-rules/protect-env"],
      }),
    );
  });

  it("accepts an empty preset array (n-created presets start at [])", () => {
    assert.ok(validatePresetShape({ description: "d", preset: [] }));
  });

  it("accepts default: true/false", () => {
    assert.ok(validatePresetShape({ description: "d", preset: [], default: true }));
    assert.ok(validatePresetShape({ description: "d", preset: [], default: false }));
  });

  it("rejects entries missing description", () => {
    assert.ok(!validatePresetShape({ preset: ["local/a"] }));
  });

  it("rejects entries missing preset", () => {
    assert.ok(!validatePresetShape({ description: "d" }));
  });

  it("rejects a non-array preset", () => {
    assert.ok(!validatePresetShape({ description: "d", preset: "local/a" }));
  });

  it("rejects a non-string preset ref", () => {
    assert.ok(!validatePresetShape({ description: "d", preset: [123] }));
  });

  it("rejects a malformed ref (owner/name, 1 slash)", () => {
    assert.ok(!validatePresetShape({ description: "d", preset: ["owner/repo"] }));
  });

  it("rejects a malformed ref (local/a/b, source 'local/a')", () => {
    assert.ok(!validatePresetShape({ description: "d", preset: ["local/a/b"] }));
  });

  it("rejects a preset carrying shell (mutual exclusivity)", () => {
    assert.ok(
      !validatePresetShape({ description: "d", preset: [], shell: "false" }),
    );
  });

  it("rejects a preset carrying hook (mutual exclusivity)", () => {
    assert.ok(
      !validatePresetShape({ description: "d", preset: [], hook: "tool_call" }),
    );
  });

  it("rejects a preset carrying when (assert-only)", () => {
    assert.ok(!validatePresetShape({ description: "d", preset: [], when: "true" }));
  });

  it("rejects a preset carrying filter (assert-only)", () => {
    assert.ok(
      !validatePresetShape({ description: "d", preset: [], filter: { toolName: "bash" } }),
    );
  });

  it("rejects non-object entries", () => {
    assert.ok(!validatePresetShape(null));
    assert.ok(!validatePresetShape("string"));
    assert.ok(!validatePresetShape(42));
  });
});

// ---------------------------------------------------------------------------
// validateRuleEntry
// ---------------------------------------------------------------------------

describe("validateRuleEntry", () => {
  it("classifies a preset as { kind: 'preset' }", () => {
    assert.deepEqual(
      validateRuleEntry({ description: "d", preset: ["local/a"] }),
      { kind: "preset" },
    );
  });

  it("classifies a shell assert as { kind: 'assert' }", () => {
    assert.deepEqual(
      validateRuleEntry({ description: "d", hook: "tool_call", shell: "false" }),
      { kind: "assert" },
    );
  });

  it("returns null for an entry matching neither shape", () => {
    assert.equal(validateRuleEntry({ description: "d" }), null);
    assert.equal(validateRuleEntry({ hook: "tool_call", shell: "false" }), null);
    assert.equal(validateRuleEntry(null), null);
  });

  it("classifies a both-fields entry as assert (preset guard rejects shell-bearing entries)", () => {
    // An entry with BOTH shell+hook and preset fails validatePresetShape (has
    // shell → mutual-exclusivity reject), so it falls through to the assert
    // guard, which accepts it (description/hook/shell present).  Such an entry
    // is rejected by the schema's oneOf before it reaches disk; the tag here
    // just reflects which guard matched.
    assert.deepEqual(
      validateRuleEntry({ description: "d", hook: "tool_call", shell: "false", preset: ["local/a"] }),
      { kind: "assert" },
    );
  });
});
