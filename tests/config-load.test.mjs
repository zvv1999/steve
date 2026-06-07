import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("example config files are valid JSON", async () => {
  const files = [
    "examples/codenext/personas/default.json",
    "examples/codenext/journeys/default.json",
    "examples/codenext/heuristics/default.json",
    "examples/codenext/visual/skillhub.json"
  ];

  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    assert.ok(parsed.id);
  }
});
