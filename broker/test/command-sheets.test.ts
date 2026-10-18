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

test("/btw opens the side question sheet, and the phone offers it where Claude Code does not list it", async () => {
  const { withPhoneCommands } = await import("../../web/src/components/commandSheets.ts");
  assert.deepEqual(commandSheet("/btw"), { sheet: "btw", title: "곁질문" });
  assert.equal(bareCommandSheet("/btw"), "btw");
  assert.equal(bareCommandSheet("/btw what now?"), undefined);
  assert.deepEqual(
    withPhoneCommands([{ name: "compact", description: "" }]).map((c) => c.name),
    ["compact", "btw"],
  );
  assert.deepEqual(
    withPhoneCommands([{ name: "btw", description: "Claude Code's own" }]).map((c) => c.description),
    ["Claude Code's own"],
  );
  assert.deepEqual(
    withPhoneCommands(undefined).map((c) => c.name),
    ["btw"],
  );
});
