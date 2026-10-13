import { test } from "node:test";
import assert from "node:assert/strict";
import { Leases } from "../src/lease.ts";
import { tempStore } from "./helpers.ts";

test("an issued token validates and a forged one does not", () => {
  const leases = new Leases(tempStore(), 60);
  const token = leases.issue("iphone", 1000);
  assert.equal(leases.validate(token, 2000), true);
  assert.equal(leases.validate(token + "x", 2000), false);
  assert.equal(leases.validate(undefined, 2000), false);
});

test("a new login replaces the previous one", () => {
  const leases = new Leases(tempStore(), 60);
  const reasons: string[] = [];
  leases.on("revoked", (r: string) => reasons.push(r));
  const first = leases.issue("iphone", 1000);
  const second = leases.issue("laptop", 2000);
  assert.equal(leases.validate(first, 3000), false);
  assert.equal(leases.validate(second, 3000), true);
  assert.deepEqual(reasons, ["taken_over"]);
  assert.equal(leases.current(3000)?.device, "laptop");
});

test("an idle lease expires", () => {
  const leases = new Leases(tempStore(), 1);
  const reasons: string[] = [];
  leases.on("revoked", (r: string) => reasons.push(r));
  const token = leases.issue("iphone", 0);
  assert.equal(leases.validate(token, 59_000), true);
  assert.equal(leases.validate(token, 59_000 + 60_001), false);
  assert.equal(leases.current(), undefined);
  assert.deepEqual(reasons, ["idle"]);
});
