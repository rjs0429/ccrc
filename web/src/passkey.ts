// Passkeys through the browser's WebAuthn API. The broker sends the options with binary fields base64url and checks
// everything that comes back; navigator.credentials is called straight from a tap, as Safari asks.

type Options = Record<string, unknown>;

function bytes(v: unknown): ArrayBuffer {
  const s = String(v).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function text(buf: ArrayBuffer | null | undefined): string | undefined {
  if (!buf) return undefined;
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const described = (list: unknown) =>
  Array.isArray(list) ? list.map((c) => ({ ...(c as Options), id: bytes((c as Options).id) }) as PublicKeyCredentialDescriptor) : undefined;

export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === "function" && Boolean(navigator.credentials?.create);
}

// Registers a passkey on this phone; the response the broker checks, or an error (see passkeyError).
export async function createPasskey(options: Options): Promise<Record<string, unknown>> {
  const user = options.user as Options;
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...(options as unknown as PublicKeyCredentialCreationOptions),
      challenge: bytes(options.challenge),
      user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: bytes(user.id) },
      excludeCredentials: described(options.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException("no credential", "NotAllowedError");
  const r = credential.response as AuthenticatorAttestationResponse;
  if (typeof r.getPublicKey !== "function" || typeof r.getAuthenticatorData !== "function") throw new DOMException("old browser", "NotSupportedError");
  return {
    id: credential.id,
    type: credential.type,
    response: {
      clientDataJSON: text(r.clientDataJSON),
      authenticatorData: text(r.getAuthenticatorData()),
      publicKey: text(r.getPublicKey()),
      publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
      transports: typeof r.getTransports === "function" ? r.getTransports() : [],
    },
  };
}

// Confirms the login with a passkey made for this page's host.
export async function assertPasskey(options: Options): Promise<Record<string, unknown>> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...(options as unknown as PublicKeyCredentialRequestOptions),
      challenge: bytes(options.challenge),
      allowCredentials: described(options.allowCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException("no credential", "NotAllowedError");
  const r = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    type: credential.type,
    response: {
      clientDataJSON: text(r.clientDataJSON),
      authenticatorData: text(r.authenticatorData),
      signature: text(r.signature),
      ...(r.userHandle ? { userHandle: text(r.userHandle) } : {}),
    },
  };
}

// What went wrong, as a sentence, for a WebAuthn error or the broker's answer to one.
export function passkeyError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return "취소했거나 시간이 지났습니다. 다시 시도하세요";
  if (name === "InvalidStateError") return "이 기기에는 이미 이 주소의 패스키가 있습니다";
  if (name === "NotSupportedError") return "이 브라우저는 패스키 등록에 필요한 기능이 없습니다";
  if (name === "SecurityError") return "이 주소에서는 패스키를 쓸 수 없습니다. tailnet HTTPS 주소로 여세요";
  return e instanceof Error ? e.message : String(e);
}
