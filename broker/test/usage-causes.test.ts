import assert from "node:assert/strict";
import { test } from "node:test";
import { usageCauses } from "../src/sessions/reports.ts";

test("the causes of usage keep each window's counts, the traits by Claude Code's open set of names, and the shares", () => {
  const c = usageCauses({
    behaviors: {
      day: {
        request_count: 4405.4,
        session_count: 3,
        behaviors: [
          { key: "subagent_heavy", pct: 99, count: 2 },
          { key: "brand_new_trait", pct: 12, count: 1 },
          { key: "max_effort", pct: 140, count: -3 },
          { key: "<img src=x>", pct: 50, count: 9 },
          { key: 7, pct: 50 },
        ],
        agents: [
          { name: "general-purpose", pct: 35 },
          { name: "workflow-subagent", pct: 48 },
          { name: "", pct: 9 },
        ],
        skills: [{ name: "update-config", pct: 1 }],
        plugins: "nope",
      },
      week: null,
    },
  });
  assert.deepEqual(c, {
    day: {
      requests: 4405,
      sessions: 3,
      traits: [
        { key: "max_effort", pct: 100, count: 0 },
        { key: "subagent_heavy", pct: 99, count: 2 },
        { key: "brand_new_trait", pct: 12, count: 1 },
      ],
      agents: [
        { name: "workflow-subagent", pct: 48 },
        { name: "general-purpose", pct: 35 },
      ],
      skills: [{ name: "update-config", pct: 1 }],
      plugins: [],
      mcpServers: [],
    },
  });
});

test("an answer without causes says there are none", () => {
  for (const r of [undefined, {}, { behaviors: null }, { behaviors: { day: 3 } }, "x"]) assert.deepEqual(usageCauses(r), { none: true }, JSON.stringify(r));
});

test("long lists and names are cut", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `n${i}`.padEnd(300, "x"), pct: i }));
  const c = usageCauses({ behaviors: { week: { mcp_servers: many } } });
  assert.equal(c.week?.mcpServers.length, 50);
  assert.equal(c.week?.mcpServers[0].pct, 79);
  assert.equal(c.week?.mcpServers[0].name.length, 200);
});
