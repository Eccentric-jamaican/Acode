const REMOTE_SESSION_STORAGE_KEY = "acode:remote-session";

export interface StoredRemoteSession {
  readonly version: 1;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly accessToken: string;
  readonly tokenType: "DPoP";
  readonly thumbprint: string;
  readonly label: string;
  readonly pairedAt: string;
}

function isStoredRemoteSession(value: unknown): value is StoredRemoteSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.httpBaseUrl === "string" &&
    typeof record.wsBaseUrl === "string" &&
    typeof record.accessToken === "string" &&
    record.tokenType === "DPoP" &&
    typeof record.thumbprint === "string" &&
    typeof record.label === "string" &&
    typeof record.pairedAt === "string"
  );
}

export function readStoredRemoteSession(): StoredRemoteSession | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(REMOTE_SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isStoredRemoteSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredRemoteSession(session: StoredRemoteSession): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(REMOTE_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredRemoteSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(REMOTE_SESSION_STORAGE_KEY);
}

export function peekPairingTokenFromUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const url = new URL(window.location.href);
  const hashToken = url.hash.startsWith("#")
    ? new URLSearchParams(url.hash.slice(1)).get("token")
    : null;
  const queryToken = url.searchParams.get("token");
  const token = hashToken ?? queryToken;
  if (!token) {
    return null;
  }
  return token;
}

export function stripPairingTokenFromUrl(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.delete("token");
  window.history.replaceState({}, document.title, url.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (!token) {
    return null;
  }
  stripPairingTokenFromUrl();
  return token;
}

export function resolveRemoteHttpBaseUrl(): string {
  if (typeof window === "undefined") {
    throw new Error("Remote pairing is only available in the browser.");
  }
  const url = new URL(window.location.href);
  const hostOverride = url.searchParams.get("host");
  if (hostOverride) {
    return new URL(hostOverride).toString();
  }
  return window.location.origin;
}

export function httpToWebSocketUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
