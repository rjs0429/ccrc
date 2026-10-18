import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkCredentials } from "../auth.ts";
import { PasskeyError, type Passkeys, type StoredPasskey } from "../passkeys.ts";
import type { StoredLease } from "../store.ts";
import { WebAuthnError, passkeyOrigin } from "../webauthn.ts";
import type { RouteDeps } from "./types.ts";

// What the phone lists of a passkey; here: made for the host the page is on.
export interface PasskeyView {
  id: string;
  device: string;
  createdAt: number;
  lastUsedAt?: number;
  backedUp?: boolean;
  here: boolean;
}

export type PasskeyDeps = RouteDeps & {
  passkeys: Passkeys;
  // Lets in a login that a passkey has yet to confirm.
  requireLogin: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
};

const ID_MAX = 2048;

const host = (req: FastifyRequest): string => String([req.headers["x-forwarded-host"]].flat()[0] || req.headers.host || "").replace(/:\d+$/, "");

function view(p: StoredPasskey, rpId: string): PasskeyView {
  return { id: p.id, device: p.device, createdAt: p.createdAt, ...(p.lastUsedAt ? { lastUsedAt: p.lastUsedAt } : {}), ...(p.backedUp ? { backedUp: true } : {}), here: p.rpId === rpId };
}

// Registering and removing a passkey asks for the password again, so a phone left logged in cannot change them.
export async function registerPasskeys(app: FastifyInstance, d: PasskeyDeps): Promise<void> {
  const auth = { preHandler: d.requireAuth };
  const login = { preHandler: d.requireLogin };
  const lease = (): StoredLease | undefined => d.leases.current();

  const fail = (req: FastifyRequest, reply: FastifyReply, e: unknown, what: string) => {
    if (!(e instanceof PasskeyError) && !(e instanceof WebAuthnError)) throw e;
    d.audit.log("passkey_failed", { device: req.device, step: what, reason: e.message });
    return reply.code(e instanceof WebAuthnError ? 400 : 409).send({ error: e instanceof WebAuthnError ? "passkey_invalid" : e.message, reason: e.message });
  };

  const password = async (req: FastifyRequest<{ Body: { password?: unknown } }>, reply: FastifyReply): Promise<boolean> => {
    const user = d.store.state.user;
    const given = req.body?.password;
    if (!user || typeof given !== "string" || given.length > 1024) {
      reply.code(400).send({ error: "invalid" });
      return false;
    }
    const check = await checkCredentials(d.store, user.id, given);
    if (check.ok) return true;
    d.audit.log("login_failed", { device: req.device, reason: check.reason, for: "passkey" });
    reply.code(check.reason === "locked" ? 429 : 403).send({ error: check.reason === "locked" ? "locked" : "wrong_password", retryAfterSec: check.retryAfterSec });
    return false;
  };

  const where = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.device === "local") {
      reply.code(400).send({ error: "local" });
      return undefined;
    }
    const w = passkeyOrigin(req.headers.origin);
    if (!w) reply.code(400).send({ error: "insecure_origin" });
    return w;
  };

  app.get("/api/passkeys", auth, async (req) => {
    const here = host(req);
    const l = lease();
    return {
      passkeys: d.passkeys.list().map((p) => view(p, here)),
      hours: d.passkeys.hours,
      local: req.device === "local",
      ...(l?.verifiedAt ? { verifiedAt: l.verifiedAt } : {}),
    };
  });

  app.post<{ Body: { password?: unknown } }>("/api/passkeys/register/options", auth, async (req, reply) => {
    const w = where(req, reply);
    if (!w || !(await password(req, reply))) return reply;
    try {
      return { options: d.passkeys.registerOptions(lease()!, w, d.store.state.user?.id ?? "ccrc") };
    } catch (e) {
      return fail(req, reply, e, "register");
    }
  });

  app.post<{ Body: { credential?: unknown } }>("/api/passkeys/register", auth, async (req, reply) => {
    const l = lease()!;
    try {
      const p = d.passkeys.register(l, req.body?.credential, req.device);
      d.leases.verified();
      d.audit.log("passkey_registered", { device: req.device, passkey: p.id.slice(0, 12), backedUp: Boolean(p.backedUp) });
      return { passkey: view(p, p.rpId) };
    } catch (e) {
      return fail(req, reply, e, "register");
    }
  });

  app.post("/api/passkeys/verify/options", login, async (req, reply) => {
    const w = passkeyOrigin(req.headers.origin);
    if (!w) return reply.code(400).send({ error: "insecure_origin" });
    try {
      return { options: d.passkeys.verifyOptions(lease()!, w) };
    } catch (e) {
      return fail(req, reply, e, "verify");
    }
  });

  app.post<{ Body: { credential?: unknown } }>("/api/passkeys/verify", login, async (req, reply) => {
    try {
      const p = d.passkeys.verify(lease()!, req.body?.credential);
      d.leases.verified();
      d.audit.log("passkey_verified", { device: req.device, passkey: p.id.slice(0, 12) });
      return { ok: true };
    } catch (e) {
      return fail(req, reply, e, "verify");
    }
  });

  app.post<{ Body: { id?: unknown; password?: unknown } }>("/api/passkeys/remove", auth, async (req, reply) => {
    const id = req.body?.id;
    if (typeof id !== "string" || !id || id.length > ID_MAX) return reply.code(400).send({ error: "invalid" });
    if (!(await password(req, reply))) return reply;
    if (!d.passkeys.remove(id)) return reply.code(404).send({ error: "not_found" });
    d.audit.log("passkey_removed", { device: req.device, passkey: id.slice(0, 12), left: d.passkeys.list().length });
    return { ok: true };
  });
}
