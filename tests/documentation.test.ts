import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateSectionedFile, type SectionedFile } from "../pi-assert/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function jsonExamples(path: string): unknown[] {
  const text = readFileSync(join(root, path), "utf8");
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
}

describe("documentation JSON examples", () => {
  for (const path of ["README.md", "skills/pi-assert/SKILL.md"]) {
    it(`${path} examples are valid sectioned configs with assertions`, () => {
      const examples = jsonExamples(path);
      assert.ok(examples.length > 0, "expected at least one JSON example");
      for (const example of examples) {
        assert.equal(typeof example, "object");
        assert.equal(validateSectionedFile(example as SectionedFile), null);
        const file = example as SectionedFile;
        const count = Object.entries(file)
          .filter(([key]) => key !== "$schema" && key !== "repos")
          .reduce((total, [, section]) =>
            total + (section && typeof section === "object" && !Array.isArray(section)
              ? Object.keys(section).length : 0), 0);
        assert.ok(count > 0, "example must load at least one entry");
      }
    });
  }
});
