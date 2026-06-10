import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { APP_DISPLAY_NAME } from "../branding";
import { createBrowserDpopProof, getOrCreateBrowserDpopKey } from "../remoteDpop";
import {
  clearStoredRemoteSession,
  httpToWebSocketUrl,
  peekPairingTokenFromUrl,
  readStoredRemoteSession,
  resolveRemoteHttpBaseUrl,
  stripPairingTokenFromUrl,
  writeStoredRemoteSession,
} from "../remoteSession";
import { resetNativeApi } from "../nativeApi";

type PairingStatus =
  | { kind: "idle" }
  | { kind: "pairing" }
  | { kind: "paired"; message: string }
  | { kind: "error"; message: string };

function detectClientDeviceType(): "desktop" | "mobile" {
  return /Android|iPhone|iPad|iPod|Mobile/iu.test(navigator.userAgent) ? "mobile" : "desktop";
}

function detectClientOs(): string {
  const userAgent = navigator.userAgent;
  if (/Android/iu.test(userAgent)) {
    return "Android";
  }
  if (/iPhone|iPad|iPod/iu.test(userAgent)) {
    return "iOS";
  }
  if (/Windows/iu.test(userAgent)) {
    return "Windows";
  }
  if (/Mac OS|Macintosh/iu.test(userAgent)) {
    return "macOS";
  }
  if (/Linux/iu.test(userAgent)) {
    return "Linux";
  }
  return navigator.platform || "Unknown";
}

function defaultClientLabel(): string {
  const deviceType = detectClientDeviceType();
  const os = detectClientOs();
  return deviceType === "mobile" ? `${os} phone` : `${os} browser`;
}

async function exchangePairingToken(input: {
  httpBaseUrl: string;
  credential: string;
  label: string;
}) {
  const freshProofKey = await getOrCreateBrowserDpopKey(input.httpBaseUrl, { forceRotate: true });
  const tokenUrl = new URL("/api/auth/token", input.httpBaseUrl).toString();
  const { proof, thumbprint } = await createBrowserDpopProof({
    method: "POST",
    url: tokenUrl,
    key: freshProofKey,
  });
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: input.credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: input.label,
    client_device_type: detectClientDeviceType(),
    client_os: detectClientOs(),
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      dpop: proof,
    },
    body,
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        access_token?: string;
        token_type?: string;
        error?: string;
        message?: string;
      }
    | null;
  if (!response.ok || !payload?.access_token || payload.token_type !== "DPoP") {
    throw new Error(payload?.message || payload?.error || "Could not pair with this backend.");
  }
  const normalizedHttpBaseUrl = new URL(input.httpBaseUrl).toString();
  writeStoredRemoteSession({
    version: 1,
    httpBaseUrl: normalizedHttpBaseUrl,
    wsBaseUrl: httpToWebSocketUrl(normalizedHttpBaseUrl),
    accessToken: payload.access_token,
    tokenType: "DPoP",
    thumbprint,
    label: input.label,
    pairedAt: new Date().toISOString(),
  });
}

function PairRouteView() {
  const existingSession = readStoredRemoteSession();
  const initialToken = useMemo(() => peekPairingTokenFromUrl(), []);
  const activePairingRef = useRef<Promise<void> | null>(null);
  const consumedCredentialRef = useRef<string | null>(null);
  const pairingRunRef = useRef(0);
  const [pairingToken, setPairingToken] = useState(initialToken ?? "");
  const [clientLabel, setClientLabel] = useState(defaultClientLabel);
  const [status, setStatus] = useState<PairingStatus>(
    existingSession && !initialToken
      ? { kind: "paired", message: "This browser is already paired." }
      : { kind: "idle" },
  );

  const runPairing = useCallback(async (credential: string) => {
    const normalizedCredential = credential.trim();
    if (normalizedCredential.length === 0) {
      return;
    }
    if (activePairingRef.current || consumedCredentialRef.current === normalizedCredential) {
      return;
    }

    consumedCredentialRef.current = normalizedCredential;
    const pairingRunId = pairingRunRef.current + 1;
    pairingRunRef.current = pairingRunId;
    setStatus({ kind: "pairing" });

    const pairingPromise = Promise.resolve().then(async () => {
      try {
        const httpBaseUrl = resolveRemoteHttpBaseUrl();
        await exchangePairingToken({
          httpBaseUrl,
          credential: normalizedCredential,
          label: clientLabel.trim() || "Browser client",
        });
        resetNativeApi();
        setStatus({ kind: "paired", message: "Pairing complete. Opening the app..." });
        window.setTimeout(() => {
          window.location.assign("/");
        }, 200);
      } catch (error) {
        consumedCredentialRef.current = null;
        setStatus({
          kind: "error",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not pair with this backend.",
        });
      } finally {
        if (pairingRunRef.current === pairingRunId) {
          activePairingRef.current = null;
        }
      }
    });

    activePairingRef.current = pairingPromise;
    await pairingPromise;
  }, [clientLabel]);

  useEffect(() => {
    if (!initialToken) {
      return;
    }
    stripPairingTokenFromUrl();
    void runPairing(initialToken);
  }, [initialToken, runPairing]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Pair this browser</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This screen creates a trusted browser session for the backend you opened.
        </p>

        <div className="mt-6 space-y-4">
          <Input
            value={clientLabel}
            onChange={(event) => setClientLabel(event.target.value)}
            placeholder="This device label"
            aria-label="Device label"
          />
          <Input
            value={pairingToken}
            onChange={(event) => setPairingToken(event.target.value)}
            placeholder="Pairing code"
            aria-label="Pairing code"
          />
        </div>

        {status.kind === "error" ? (
          <p className="mt-4 text-sm text-destructive">{status.message}</p>
        ) : status.kind === "paired" ? (
          <p className="mt-4 text-sm text-emerald-600">{status.message}</p>
        ) : status.kind === "pairing" ? (
          <p className="mt-4 text-sm text-muted-foreground">Securing this browser and pairing…</p>
        ) : existingSession ? (
          <p className="mt-4 text-sm text-muted-foreground">
            This browser already has a stored session for remote access.
          </p>
        ) : null}

        <div className="mt-6 flex gap-2">
          <Button
            className="flex-1"
            disabled={status.kind === "pairing" || pairingToken.trim().length === 0}
            onClick={() => void runPairing(pairingToken.trim())}
          >
            Pair browser
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              clearStoredRemoteSession();
              resetNativeApi();
              pairingRunRef.current += 1;
              activePairingRef.current = null;
              consumedCredentialRef.current = null;
              setStatus({ kind: "idle" });
            }}
          >
            Reset
          </Button>
        </div>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/pair")({
  component: PairRouteView,
});
