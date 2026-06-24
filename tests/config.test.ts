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
  validateEntryShape,
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
  it("accepts an entry with hook + shell", () => {
    assert.ok(validateEntryShape({ hook: "tool_call", shell: "false" }));
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

  it("rejects entries missing hook", () => {
    assert.ok(!validateEntryShape({ shell: "false" }));
  });

  it("rejects entries missing shell", () => {
    assert.ok(!validateEntryShape({ hook: "tool_call" }));
  });

  it("rejects non-object entries", () => {
    assert.ok(!validateEntryShape(null));
    assert.ok(!validateEntryShape("string"));
    assert.ok(!validateEntryShape(42));
  });

  it("does NOT require description by default (on-disk entries)", () => {
    assert.ok(validateEntryShape({ hook: "tool_call", shell: "false" }));
  });

  it("requires description when { requireDescription: true } (rule-repo entries)", () => {
    assert.ok(
      !validateEntryShape({ hook: "tool_call", shell: "false" }, {
        requireDescription: true,
      }),
    );
    assert.ok(
      validateEntryShape(
        { description: "d", hook: "tool_call", shell: "false" },
        { requireDescription: true },
      ),
    );
  });

  it("rejects non-string description under requireDescription", () => {
    assert.ok(
      !validateEntryShape(
        { description: 5, hook: "tool_call", shell: "false" },
        { requireDescription: true },
      ),
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
