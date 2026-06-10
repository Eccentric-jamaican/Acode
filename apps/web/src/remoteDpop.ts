export interface BrowserDpopKey {
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: JsonWebKey;
  readonly thumbprint: string;
}

const REMOTE_DPOP_STORAGE_PREFIX = "acode:remote-dpop:";
const REMOTE_DPOP_STORAGE_KEY = `${REMOTE_DPOP_STORAGE_PREFIX}browser-key`;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(/=+$/g, "");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
}

async function computeThumbprint(publicJwk: JsonWebKey): Promise<string> {
  return encodeBase64Url(
    await sha256(
      stableStringify({
        crv: publicJwk.crv,
        kty: publicJwk.kty,
        x: publicJwk.x,
        y: publicJwk.y,
      }),
    ),
  );
}

async function computeAccessTokenHash(accessToken: string): Promise<string> {
  return encodeBase64Url(await sha256(accessToken));
}

function storageKey(_scope: string): string {
  return REMOTE_DPOP_STORAGE_KEY;
}

function storageKeyCandidates(scope: string): string[] {
  const candidates = [
    storageKey(scope),
    `${REMOTE_DPOP_STORAGE_PREFIX}${normalizeDpopKeyScope(scope)}`,
    `${REMOTE_DPOP_STORAGE_PREFIX}${scope}`,
  ];
  try {
    const url = new URL(scope);
    if (url.pathname === "/" && url.search === "" && url.hash === "") {
      candidates.push(`${REMOTE_DPOP_STORAGE_PREFIX}${url.origin}`);
    }
  } catch {
    // Non-URL scopes only use the raw and normalized candidate above.
  }
  return [...new Set(candidates)];
}

function normalizeDpopKeyScope(scope: string): string {
  try {
    return new URL(scope).toString();
  } catch {
    return scope;
  }
}

function readStoredDpopKey(scope: string): BrowserDpopKey | null {
  const keys = storageKeyCandidates(scope);
  for (const key of keys) {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as BrowserDpopKey;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.thumbprint === "string" &&
        parsed.privateJwk &&
        parsed.publicJwk
      ) {
        if (key !== storageKey(scope)) {
          writeStoredDpopKey(scope, parsed);
        }
        return parsed;
      }
    } catch {
      // ignore malformed storage
    }
  }
  return null;
}

function writeStoredDpopKey(scope: string, key: BrowserDpopKey): void {
  window.localStorage.setItem(storageKey(scope), JSON.stringify(key));
}

export function clearStoredBrowserDpopKey(scope: string): void {
  for (const key of storageKeyCandidates(scope)) {
    window.localStorage.removeItem(key);
  }
}

export async function getOrCreateBrowserDpopKey(
  scope: string,
  options?: { forceRotate?: boolean },
): Promise<BrowserDpopKey> {
  if (options?.forceRotate) {
    clearStoredBrowserDpopKey(scope);
  } else {
    const stored = readStoredDpopKey(scope);
    if (stored) {
      return stored;
    }
  }
  const generated = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", generated.privateKey);
  const publicJwk = await globalThis.crypto.subtle.exportKey("jwk", generated.publicKey);
  const thumbprint = await computeThumbprint(publicJwk);
  const key = { privateJwk, publicJwk, thumbprint } satisfies BrowserDpopKey;
  writeStoredDpopKey(scope, key);
  return key;
}

function normalizeProofUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  return parsed.toString();
}

function derToJoseSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) {
    return signature;
  }
  if (signature[0] !== 0x30) {
    throw new Error("Invalid DER ECDSA signature.");
  }
  let offset = 2;
  if (signature[1] && signature[1] > 0x7f) {
    offset = 2 + (signature[1] & 0x7f);
  }
  if (signature[offset] !== 0x02) {
    throw new Error("Invalid DER ECDSA signature.");
  }
  const rLength = signature[offset + 1] ?? 0;
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  const sOffset = offset + 2 + rLength;
  if (signature[sOffset] !== 0x02) {
    throw new Error("Invalid DER ECDSA signature.");
  }
  const sLength = signature[sOffset + 1] ?? 0;
  const s = signature.slice(sOffset + 2, sOffset + 2 + sLength);
  const result = new Uint8Array(64);
  result.set(trimTo32Bytes(r), 0);
  result.set(trimTo32Bytes(s), 32);
  return result;
}

function trimTo32Bytes(bytes: Uint8Array): Uint8Array {
  let index = 0;
  while (index < bytes.length - 1 && bytes[index] === 0) {
    index += 1;
  }
  const trimmed = bytes.slice(index);
  if (trimmed.length > 32) {
    return trimmed.slice(trimmed.length - 32);
  }
  const padded = new Uint8Array(32);
  padded.set(trimmed, 32 - trimmed.length);
  return padded;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export async function createBrowserDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly key: BrowserDpopKey;
  readonly accessToken?: string;
}): Promise<{ proof: string; thumbprint: string }> {
  const normalizedUrl = normalizeProofUrl(input.url);
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: input.key.publicJwk,
  };
  const payload = {
    htm: input.method.toUpperCase(),
    htu: normalizedUrl,
    jti: randomId(),
    iat: Math.floor(Date.now() / 1000),
    ...(input.accessToken ? { ath: await computeAccessTokenHash(input.accessToken) } : {}),
  };
  const encodedHeader = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    input.key.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const derSignature = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  const proof = `${signingInput}.${encodeBase64Url(derToJoseSignature(derSignature))}`;
  return { proof, thumbprint: input.key.thumbprint };
}
