import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const source = await fs.readFile("lib/catalog.ts", "utf8");
const compiled = ts.transpile(source, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
});
const { daysLeft } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
assert.equal(daysLeft("2026-09-20", new Date("2026-09-20T14:59:59Z")), 0);
assert.equal(daysLeft("2026-09-21", new Date("2026-09-20T14:59:59Z")), 1);
assert.equal(daysLeft("2026-09-20", new Date("2026-09-20T15:00:00Z")), -1);
assert.equal(daysLeft("2026-09-21", new Date("2026-09-20T15:00:00Z")), 0);
console.log("PASS: four Korea midnight expiration boundary checks");
