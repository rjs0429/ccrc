import assert from "node:assert/strict";
import { test } from "node:test";
import { bareCommandSheet, commandSheet } from "../../web/src/components/commandSheets.ts";

test("/context opens a Context sheet of its own and /usage the usage sheet", () => {
  assert.deepEqual(commandSheet("context"), { sheet: "context", title: "Context" });
  assert.equal(commandSheet("/usage")?.sheet, "usage");
  assert.equal(commandSheet("cost")?.sheet, "usage");
  assert.equal(bareCommandSheet(" /context "), "context");
  assert.equal(bareCommandSheet("/context more"), undefined);
  assert.equal(commandSheet("compact"), undefined);
});
