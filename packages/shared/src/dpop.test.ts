import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  normalizeDpopHtu,
  type DpopPublicJwk,
  verifyDpopProof,
} from "./dpop";

function signDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk | (DpopPublicJwk & { readonly d: string });
  readonly accessToken?: string;
}) {
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: input.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function encodeBase64Url(value: Uint8Array | string) {
  return Buffer.from(value).toString("base64url");
}

describe("verifyDpopProof", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const proof = signDpopProof({
    method: "POST",
    url: "https://example.com/oauth/token",
    iat: 100,
    privateKey,
    publicJwk,
  });

  it("verifies an ES256 DPoP proof and returns the RFC 7638 thumbprint", async () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    await expect(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
    ).resolves.toMatchObject({
      ok: true,
      thumbprint,
      jti: "proof-1",
    });
  });

  it("verifies browser WebCrypto ECDSA signatures", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const browserPublicJwk = (await crypto.subtle.exportKey(
      "jwk",
      keyPair.publicKey,
    )) as DpopPublicJwk;
    const header = encodeBase64Url(
      JSON.stringify({
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: browserPublicJwk,
      }),
    );
    const payload = encodeBase64Url(
      JSON.stringify({
        htm: "POST",
        htu: "http://phone.example.test/api/auth/token",
        jti: "browser-proof-1",
        iat: 100,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    );

    await expect(
      verifyDpopProof({
        proof: `${signingInput}.${encodeBase64Url(signature)}`,
        method: "POST",
        url: "http://phone.example.test/api/auth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: computeDpopJwkThumbprint(browserPublicJwk),
      }),
    ).resolves.toMatchObject({ ok: true, jti: "browser-proof-1" });
  });

  it("rejects method, URL, thumbprint, and time-window mismatches", async () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    await expect(
      verifyDpopProof({
        proof,
        method: "GET",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/other",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: "other-thumbprint",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 1_000,
        expectedThumbprint: thumbprint,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("requires the RFC 9449 access token hash when an access token is expected", async () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const accessTokenProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
      accessToken: "clerk-access-token",
    });

    await expect(
      verifyDpopProof({
        proof: accessTokenProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "clerk-access-token",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "clerk-access-token",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "DPoP access token hash mismatch." });
    await expect(
      verifyDpopProof({
        proof: accessTokenProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "other-access-token",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "DPoP access token hash mismatch." });
  });

  it("normalizes htu by excluding query and fragment components per RFC 9449", async () => {
    expect(normalizeDpopHtu("https://example.com/v1/environments/env/connect?foo=bar#frag")).toBe(
      "https://example.com/v1/environments/env/connect",
    );

    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const queryProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
    });

    await expect(
      verifyDpopProof({
        proof: queryProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect?foo=bar#frag",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects DPoP public JWK headers that expose private key material", async () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const privateJwk = privateKey.export({ format: "jwk" }) as DpopPublicJwk & {
      readonly d: string;
    };
    const proofWithPrivateJwk = signDpopProof({
      method: "POST",
      url: "https://example.com/oauth/token",
      iat: 100,
      privateKey,
      publicJwk: privateJwk,
    });

    await expect(
      verifyDpopProof({
        proof: proofWithPrivateJwk,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "Invalid DPoP JWT header." });
  });
});
