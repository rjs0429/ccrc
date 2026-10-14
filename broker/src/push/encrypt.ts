import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

// A subscription's keys as the browser gives them, base64url: its P-256 public key and auth secret.
export interface ClientKeys {
  p256dh: string;
  auth: string;
}

const RECORD_SIZE = 4096;
const OVERHEAD = 86 + 1 + 16;
export const MAX_PLAINTEXT = RECORD_SIZE - OVERHEAD;

function hkdf(ikm: Buffer, salt: Buffer, info: string | Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

// RFC 8291 message encryption: a single aes128gcm record (RFC 8188) keyed from a fresh ECDH key pair,
// the subscription's public key and its auth secret. `fixed` replays the RFC's example.
export function encrypt(plaintext: Buffer, keys: ClientKeys, fixed: { salt?: Buffer; privateKey?: Buffer } = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw Error("push message is too long");
  const clientPublic = Buffer.from(keys.p256dh, "base64url");
  const ecdh = createECDH("prime256v1");
  if (fixed.privateKey) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const salt = fixed.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPublic, serverPublic]);
  const ikm = hkdf(ecdh.computeSecret(clientPublic), Buffer.from(keys.auth, "base64url"), keyInfo, 32);
  const cek = hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(ikm, salt, "Content-Encoding: nonce\0", 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, sealed]);
}
