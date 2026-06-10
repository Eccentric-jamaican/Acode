import type { NativeApi } from "@t3tools/contracts";

import { createBrowserDpopProof, getOrCreateBrowserDpopKey } from "./remoteDpop";
import { readStoredRemoteSession, type StoredRemoteSession } from "./remoteSession";
import { createWsNativeApi, resetWsNativeApi } from "./wsNativeApi";

let cachedApi: NativeApi | undefined;

async function resolveRemoteWebSocketTicketUrl(
  baseUrl: string,
  remoteSession: StoredRemoteSession,
): Promise<string> {
  const proofKey = await getOrCreateBrowserDpopKey(remoteSession.httpBaseUrl);
  const ticketUrl = new URL("/api/auth/websocket-ticket", remoteSession.httpBaseUrl).toString();
  const { proof } = await createBrowserDpopProof({
    method: "POST",
    url: ticketUrl,
    key: proofKey,
    accessToken: remoteSession.accessToken,
  });
  const response = await fetch(ticketUrl, {
    method: "POST",
    headers: {
      authorization: `DPoP ${remoteSession.accessToken}`,
      dpop: proof,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        ticket?: string;
        error?: string;
        message?: string;
      }
    | null;
  if (!response.ok || !payload?.ticket) {
    throw new Error(
      payload?.message || payload?.error || "Could not authorize the remote WebSocket connection.",
    );
  }
  const url = new URL(baseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsTicket", payload.ticket);
  return url.toString();
}

function canCreateWsNativeApi(): boolean {
  if (typeof window === "undefined") return false;
  if (window.desktopBridge || window.nativeApi) return true;

  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (typeof envUrl === "string" && envUrl.length > 0) {
    return true;
  }

  if (readStoredRemoteSession()) {
    return true;
  }

  return !import.meta.env.DEV;
}

export function resetNativeApi(): void {
  cachedApi = undefined;
  resetWsNativeApi();
}

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  if (!canCreateWsNativeApi()) {
    return undefined;
  }

  const remoteSession = readStoredRemoteSession();
  cachedApi = createWsNativeApi(
    remoteSession
      ? {
          url: remoteSession.wsBaseUrl,
          authProvider: {
            resolveUrl: (baseUrl) => resolveRemoteWebSocketTicketUrl(baseUrl, remoteSession),
          },
        }
      : undefined,
  );
  return cachedApi;
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}
