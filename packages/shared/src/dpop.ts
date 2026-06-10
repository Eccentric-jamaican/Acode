import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

export type DpopPublicJwk = {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
};

type DpopJwtHeader = {
  readonly typ: string;
  readonly alg: string;
  readonly jwk: DpopPublicJwk;
};

type DpopJwtPayload = {
  readonly htm: string;
  readonly htu: string;
  readonly jti: string;
  readonly iat: number;
  readonly ath?: string;
};

export type DpopVerificationResult =
  | {
      readonly ok: true;
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

const DPOP_TYP = "dpop+jwt";
const DPOP_ALG = "ES256";
const DEFAULT_MAX_AGE_SECONDS = 300;

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return new Uint8Array(Buffer.from(`${normalized}${padding}`, "base64"));
}

function decodeBase64UrlString(value: string): string {
  return Buffer.from(decodeBase64Url(value)).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Bytes(input: Uint8Array | string): Uint8Array {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function decodeJson(value: string): unknown {
  return JSON.parse(decodeBase64UrlString(value)) as unknown;
}

function isDpopPublicJwk(value: unknown): value is DpopPublicJwk {
  return (
    isRecord(value) &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    value.x.length > 0 &&
    typeof value.y === "string" &&
    value.y.length > 0 &&
    !("d" in value)
  );
}

function isDpopJwtHeader(value: unknown): value is DpopJwtHeader {
  return (
    isRecord(value) &&
    value.typ === DPOP_TYP &&
    value.alg === DPOP_ALG &&
    isDpopPublicJwk(value.jwk)
  );
}

function isDpopJwtPayload(value: unknown): value is DpopJwtPayload {
  return (
    isRecord(value) &&
    typeof value.htm === "string" &&
    value.htm.length > 0 &&
    typeof value.htu === "string" &&
    value.htu.length > 0 &&
    typeof value.jti === "string" &&
    value.jti.length > 0 &&
    typeof value.iat === "number" &&
    Number.isInteger(value.iat)
  );
}

function dpopThumbprintInput(jwk: DpopPublicJwk): string {
  return stableStringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

export function normalizeDpopHtu(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function computeDpopJwkThumbprint(jwk: DpopPublicJwk): string {
  return encodeBase64Url(sha256Bytes(dpopThumbprintInput(jwk)));
}

export function computeDpopAccessTokenHash(accessToken: string): string {
  return encodeBase64Url(sha256Bytes(accessToken));
}

function jwkToRawPublicKey(jwk: DpopPublicJwk): Uint8Array {
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Invalid P-256 public key coordinate length.");
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return publicKey;
}

function verifyEs256CompactSignature(input: {
  readonly jwk: DpopPublicJwk;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}): boolean {
  const publicKey = createPublicKey({
    key: {
      kty: input.jwk.kty,
      crv: input.jwk.crv,
      x: input.jwk.x,
      y: input.jwk.y,
    },
    format: "jwk",
  });
  const signingBytes = Buffer.from(input.signingInput);
  const rawSignature = Buffer.from(input.signature);
  const rawVerified = verifySignature(
    "sha256",
    signingBytes,
    {
      key: publicKey,
      dsaEncoding: "ieee-p1363",
    },
    rawSignature,
  );
  if (rawVerified) {
    return true;
  }

  const derSignature = Buffer.from(joseToDerEcdsaSignature(input.signature));
  return verifySignature(
    "sha256",
    signingBytes,
    {
      key: publicKey,
      dsaEncoding: "der",
    },
    derSignature,
  );
}

function joseToDerEcdsaSignature(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) {
    throw new Error("Invalid ECDSA signature length.");
  }
  const r = trimIntegerBytes(signature.slice(0, 32));
  const s = trimIntegerBytes(signature.slice(32));
  const totalLength = 2 + r.length + 2 + s.length;
  const der = new Uint8Array(2 + totalLength);
  der[0] = 0x30;
  der[1] = totalLength;
  der[2] = 0x02;
  der[3] = r.length;
  der.set(r, 4);
  const sOffset = 4 + r.length;
  der[sOffset] = 0x02;
  der[sOffset + 1] = s.length;
  der.set(s, sOffset + 2);
  return der;
}

function trimIntegerBytes(bytes: Uint8Array): Uint8Array {
  let index = 0;
  while (index < bytes.length - 1 && bytes[index] === 0) {
    index += 1;
  }
  const slice = bytes.slice(index);
  if ((slice[0] ?? 0) & 0x80) {
    const prefixed = new Uint8Array(slice.length + 1);
    prefixed[0] = 0;
    prefixed.set(slice, 1);
    return prefixed;
  }
  return slice;
}

export async function verifyDpopProof(input: {
  readonly proof: string | null | undefined;
  readonly method: string;
  readonly url: string;
  readonly nowEpochSeconds: number;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
  readonly maxAgeSeconds?: number;
}): Promise<DpopVerificationResult> {
  if (!input.proof?.trim()) {
    return { ok: false, reason: "Missing DPoP proof." };
  }

  const parts = input.proof.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "Invalid DPoP compact JWT." };
  }

  try {
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (!isDpopJwtHeader(header)) {
      return { ok: false, reason: "Invalid DPoP JWT header." };
    }
    if (!isDpopJwtPayload(payload)) {
      return { ok: false, reason: "Invalid DPoP JWT payload." };
    }

    const thumbprint = computeDpopJwkThumbprint(header.jwk);
    if (input.expectedThumbprint && thumbprint !== input.expectedThumbprint) {
      return { ok: false, reason: "DPoP key thumbprint mismatch." };
    }
    if (payload.htm.toUpperCase() !== input.method.toUpperCase()) {
      return { ok: false, reason: "DPoP method mismatch." };
    }
    const normalizedHtu = normalizeDpopHtu(input.url);
    if (normalizedHtu === null || payload.htu !== normalizedHtu) {
      return { ok: false, reason: "DPoP URL mismatch." };
    }
    if (input.expectedAccessToken) {
      const expectedAth = computeDpopAccessTokenHash(input.expectedAccessToken);
      if (payload.ath !== expectedAth) {
        return { ok: false, reason: "DPoP access token hash mismatch." };
      }
    }

    const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    if (
      payload.iat > input.nowEpochSeconds + 5 ||
      input.nowEpochSeconds - payload.iat > maxAgeSeconds
    ) {
      return { ok: false, reason: "DPoP proof is outside the allowed time window." };
    }

    const verified = verifyEs256CompactSignature({
      jwk: header.jwk,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: decodeBase64Url(parts[2]),
    });

    return verified
      ? {
          ok: true,
          thumbprint,
          jti: payload.jti,
          iat: payload.iat,
        }
      : { ok: false, reason: "Invalid DPoP signature." };
  } catch {
    return { ok: false, reason: "Invalid DPoP proof." };
  }
}

export function rawPublicKeyFromDpopJwk(jwk: DpopPublicJwk): Uint8Array {
  return jwkToRawPublicKey(jwk);
}
