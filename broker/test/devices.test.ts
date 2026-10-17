import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceGate } from "../src/devices.ts";

const status = async () => ({
  Self: { HostName: "laptop", DNSName: "laptop.example.ts.net.", TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"] },
  Peer: {
    a: { HostName: "localhost", DNSName: "phone.example.ts.net.", TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"] },
    b: { HostName: "other-host", DNSName: "other-host.example.ts.net.", TailscaleIPs: ["100.64.0.3"] },
  },
});

test("local requests pass only when allowed", async () => {
  assert.deepEqual(await new DeviceGate([], true, status).check("127.0.0.1", undefined), { ok: true, device: "local" });
  assert.equal((await new DeviceGate([], false, status).check("127.0.0.1", undefined)).ok, false);
});

test("requests that do not come through loopback are refused", async () => {
  assert.equal((await new DeviceGate(["phone"], true, status).check("100.64.0.2", undefined)).ok, false);
});

test("allowed tailnet machines pass by IPv4 and IPv6", async () => {
  const gate = new DeviceGate(["phone"], false, status);
  assert.deepEqual(await gate.check("127.0.0.1", "100.64.0.2"), { ok: true, device: "phone" });
  assert.deepEqual(await gate.check("::1", "fd7a:115c:a1e0::2"), { ok: true, device: "phone" });
});

test("other machines are refused, judged by the last forwarded address", async () => {
  const gate = new DeviceGate(["phone"], true, status);
  assert.deepEqual(await gate.check("127.0.0.1", "100.64.0.3"), { ok: false, ip: "100.64.0.3" });
  assert.equal((await gate.check("127.0.0.1", "100.64.0.2, 100.64.0.3")).ok, false);
  assert.equal((await gate.check("127.0.0.1", "100.64.0.3, 100.64.0.2")).ok, true);
});

test("a changed device list and allowLocal hold from the next request", async () => {
  const gate = new DeviceGate(["phone"], true, status);
  assert.equal((await gate.check("127.0.0.1", "100.64.0.3")).ok, false);
  gate.update(["phone", "other-host"], false);
  assert.deepEqual(await gate.check("127.0.0.1", "100.64.0.3"), { ok: true, device: "other-host" });
  assert.equal((await gate.check("127.0.0.1", undefined)).ok, false);
  gate.update([], true);
  assert.equal((await gate.check("127.0.0.1", "100.64.0.2")).ok, false);
});

test("only the MagicDNS name of a machine of this tailnet counts, not the host name it reports itself", async () => {
  const st = async () => ({
    Self: { HostName: "laptop", DNSName: "laptop.example.ts.net.", TailscaleIPs: ["100.64.0.1"] },
    Peer: {
      a: { HostName: "phone", DNSName: "phone-1.example.ts.net.", TailscaleIPs: ["100.64.0.2"] },
      b: { HostName: "phone", DNSName: "other-host.other.ts.net.", TailscaleIPs: ["100.64.0.3"] },
      c: { HostName: "x", DNSName: "phone.other.ts.net.", TailscaleIPs: ["100.64.0.4"] },
      d: { HostName: "y", DNSName: "tablet.example.ts.net.", TailscaleIPs: ["100.64.0.5"], ShareeNode: true },
    },
  });
  const gate = new DeviceGate(["phone", "tablet"], false, st);
  assert.deepEqual(await gate.check("127.0.0.1", "100.64.0.2"), { ok: false, ip: "100.64.0.2" }, "a host name of its own choosing");
  assert.deepEqual(await gate.check("127.0.0.1", "100.64.0.3"), { ok: false, ip: "100.64.0.3" }, "shared in from another tailnet");
  assert.deepEqual(await gate.check("127.0.0.1", "100.64.0.4"), { ok: false, ip: "100.64.0.4" }, "the same label in another tailnet");
  assert.deepEqual(await gate.check("127.0.0.1", "100.64.0.5"), { ok: false, ip: "100.64.0.5" }, "a sharee machine");
  assert.equal((await gate.check("127.0.0.1", undefined)).ok, false);
});
