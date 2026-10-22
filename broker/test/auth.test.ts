import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCredentials, credentialsWatch, setCredentials } from "../src/auth.ts";
import { Store } from "../src/store.ts";
import path from "node:path";
import { tempDir, tempStore } from "./helpers.ts";

test("login is refused until credentials are set", async () => {
  assert.deepEqual(await checkCredentials(tempStore(), "owner", "whatever-pass"), { ok: false, reason: "not_configured" });
});

test("only the right ID and password pass", async () => {
  const store = tempStore();
  await setCredentials(store, "owner", "correct horse battery");
  assert.deepEqual(await checkCredentials(store, "owner", "correct horse battery"), { ok: true });
  assert.equal((await checkCredentials(store, "owner", "wrong password!")).ok, false);
  assert.equal((await checkCredentials(store, "intruder", "correct horse battery")).ok, false);
});

test("five failures lock the login, and the lock grows", async () => {
  const store = tempStore();
  await setCredentials(store, "owner", "correct horse battery");
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal((await checkCredentials(store, "owner", "nope-nope-nope", t0)).ok, false);
  const fifth = await checkCredentials(store, "owner", "nope-nope-nope", t0);
  assert.deepEqual(fifth, { ok: false, reason: "locked", retryAfterSec: 300 });

  const whileLocked = await checkCredentials(store, "owner", "correct horse battery", t0 + 60_000);
  assert.equal(whileLocked.ok === false && whileLocked.reason, "locked");

  const sixth = await checkCredentials(store, "owner", "nope-nope-nope", t0 + 301_000);
  assert.deepEqual(sixth, { ok: false, reason: "locked", retryAfterSec: 600 });

  assert.deepEqual(await checkCredentials(store, "owner", "correct horse battery", t0 + 902_000), { ok: true });
  assert.deepEqual(store.state.lockout, { failures: 0, lockedUntil: 0 });
});

test("lockout survives a restart", async () => {
  const file = path.join(tempDir(), "state.json");
  const store = new Store(file);
  await setCredentials(store, "owner", "correct horse battery");
  for (let i = 0; i < 5; i++) await checkCredentials(store, "owner", "nope-nope-nope", 5_000);
  const reopened = new Store(file);
  const r = await checkCredentials(reopened, "owner", "correct horse battery", 6_000);
  assert.equal(r.ok === false && r.reason, "locked");
});

test("weak IDs and short passwords are rejected", async () => {
  const store = tempStore();
  await assert.rejects(setCredentials(store, "a", "long enough password"));
  await assert.rejects(setCredentials(store, "owner name", "long enough password"));
  await assert.rejects(setCredentials(store, "owner", "short"));
  assert.equal(store.state.user, undefined);
});

test("the broker's watch of the credentials file sees a password set elsewhere once, even after another reload", async () => {
  const file = path.join(tempDir(), "state.json");
  const broker = new Store(file);
  await setCredentials(broker, "owner", "correct horse battery");
  broker.state.lease = { tokenHash: "00", device: "phone", createdAt: 1, lastSeen: 1 };
  broker.save();
  const look = credentialsWatch(broker);
  assert.deepEqual(look(), { leaseGone: false, passwordSet: false });

  await setCredentials(new Store(file), "owner", "another horse battery");
  broker.reload();
  assert.deepEqual(look(), { leaseGone: false, passwordSet: true }, "as `ccrc passwd`, with /api/me reloading the store first");
  assert.deepEqual(look(), { leaseGone: false, passwordSet: false });

  const cli = new Store(file);
  delete cli.state.lease;
  cli.save();
  assert.deepEqual(look(), { leaseGone: true, passwordSet: false }, "as `ccrc logout`");
});
