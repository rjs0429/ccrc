import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// A software authenticator that answers WebAuthn options as a phone's browser hands its answer to the broker: binary
// fields base64url, the new key as SPKI.
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

const b64 = (b: Buffer) => b.toString("base64url");
const sha256 = (d: Buffer | string) => createHash("sha256").update(d).digest();

export type Alg = -7 | -8 | -257;

function keyPair(alg: Alg, rsaBits = 2048): { publicKey: KeyObject; privateKey: KeyObject } {
  if (alg === -7) return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  if (alg === -8) return generateKeyPairSync("ed25519");
  return generateKeyPairSync("rsa", { modulusLength: rsaBits });
}

export interface Tweaks {
  type?: string;
  origin?: string;
  challenge?: string;
  rpId?: string;
  flags?: number;
  crossOrigin?: boolean;
  counter?: number;
  id?: Buffer;
  alg?: number;
  spki?: Buffer;
}

export class Authenticator {
  readonly id = randomBytes(16);
  readonly alg: Alg;
  counter: number;
  private keys: { publicKey: KeyObject; privateKey: KeyObject };

  constructor(alg: Alg = -7, o: { counter?: number; rsaBits?: number } = {}) {
    this.alg = alg;
    this.counter = o.counter ?? 0;
    this.keys = keyPair(alg, o.rsaBits);
  }

  spki(): Buffer {
    return this.keys.publicKey.export({ type: "spki", format: "der" });
  }

  private authData(rpId: string, flags: number, counter: number, attested: boolean): Buffer {
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.id.length);
    // Stands in for the COSE key; the broker reads the key from the SPKI.
    return Buffer.concat([head, Buffer.alloc(16), len, this.id, Buffer.from([0xa0])]);
  }

  private clientData(type: string, challenge: string, origin: string, crossOrigin?: boolean): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, ...(crossOrigin !== undefined ? { crossOrigin } : {}) }));
  }

  create(options: Record<string, unknown>, origin: string, t: Tweaks = {}): Record<string, unknown> {
    const rp = options.rp as { id: string };
    const data = this.authData(t.rpId ?? rp.id, t.flags ?? UP | UV | BE | BS | AT, t.counter ?? this.counter, true);
    return {
      id: b64(t.id ?? this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64(this.clientData(t.type ?? "webauthn.create", t.challenge ?? String(options.challenge), t.origin ?? origin, t.crossOrigin)),
        authenticatorData: b64(data),
        publicKey: b64(t.spki ?? this.spki()),
        publicKeyAlgorithm: t.alg ?? this.alg,
        transports: ["internal", "hybrid", "carrier-pigeon"],
      },
    };
  }

  get(options: Record<string, unknown>, origin: string, t: Tweaks = {}): Record<string, unknown> {
    if (t.counter === undefined && this.counter > 0) this.counter++;
    const data = this.authData(t.rpId ?? String(options.rpId), t.flags ?? UP | UV | BE | BS, t.counter ?? this.counter, false);
    const client = this.clientData(t.type ?? "webauthn.get", t.challenge ?? String(options.challenge), t.origin ?? origin, t.crossOrigin);
    const signed = Buffer.concat([data, sha256(client)]);
    const signature = this.alg === -8 ? sign(null, signed, this.keys.privateKey) : sign("sha256", signed, this.keys.privateKey);
    return { id: b64(t.id ?? this.id), type: "public-key", response: { clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(signature) } };
  }
}

export const FLAGS = { UP, UV, BE, BS, AT };
