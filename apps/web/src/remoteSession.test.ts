import { afterEach, describe, expect, it, vi } from "vitest";

import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  takePairingTokenFromUrl,
} from "./remoteSession";

function installBrowserLocation(href: string) {
  const windowMock = {
    location: { href },
    history: {
      replaceState: vi.fn((_state: unknown, _title: string, nextUrl: string | URL) => {
        windowMock.location.href = String(nextUrl);
      }),
    },
    localStorage: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  };
  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("document", { title: "A Code" });
  return windowMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remoteSession pairing URL helpers", () => {
  it("peeks at hash pairing tokens without mutating the URL", () => {
    const windowMock = installBrowserLocation("https://desktop.example.test/pair#token=abc123");

    expect(peekPairingTokenFromUrl()).toBe("abc123");
    expect(windowMock.location.href).toBe("https://desktop.example.test/pair#token=abc123");
    expect(windowMock.history.replaceState).not.toHaveBeenCalled();
  });

  it("strips pairing tokens separately from reading them", () => {
    const windowMock = installBrowserLocation(
      "https://desktop.example.test/pair?token=query-token#token=hash-token",
    );

    expect(takePairingTokenFromUrl()).toBe("hash-token");
    expect(windowMock.location.href).toBe("https://desktop.example.test/pair");
    expect(windowMock.history.replaceState).toHaveBeenCalledTimes(1);
  });

  it("strips query pairing tokens when no hash token is present", () => {
    const windowMock = installBrowserLocation("https://desktop.example.test/pair?token=query-token");

    stripPairingTokenFromUrl();

    expect(windowMock.location.href).toBe("https://desktop.example.test/pair");
    expect(windowMock.history.replaceState).toHaveBeenCalledTimes(1);
  });
});
