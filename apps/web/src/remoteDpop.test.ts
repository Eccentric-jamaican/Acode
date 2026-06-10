import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStoredBrowserDpopKey, getOrCreateBrowserDpopKey } from "./remoteDpop";

const STORAGE_PREFIX = "acode:remote-dpop:";
const GLOBAL_STORAGE_KEY = `${STORAGE_PREFIX}browser-key`;

function installLocalStorageMock() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  return values;
}

describe("remote DPoP browser key storage", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = installLocalStorageMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the same stored key for equivalent URL scopes", async () => {
    const first = await getOrCreateBrowserDpopKey("https://desktop.example.test");
    const second = await getOrCreateBrowserDpopKey("https://desktop.example.test/");

    expect(second.thumbprint).toBe(first.thumbprint);
  });

  it("migrates legacy unnormalized URL scope keys", async () => {
    const legacyScope = "https://desktop.example.test";
    const normalizedScope = "https://desktop.example.test/";
    const legacyKey = `${STORAGE_PREFIX}${legacyScope}`;
    const generated = await getOrCreateBrowserDpopKey(normalizedScope);

    storage.set(legacyKey, storage.get(GLOBAL_STORAGE_KEY)!);
    storage.delete(GLOBAL_STORAGE_KEY);

    const migrated = await getOrCreateBrowserDpopKey(normalizedScope);

    expect(migrated.thumbprint).toBe(generated.thumbprint);
    expect(storage.get(GLOBAL_STORAGE_KEY)).toBe(storage.get(legacyKey));
  });

  it("clears both normalized and legacy URL scope keys", async () => {
    const legacyScope = "https://desktop.example.test";
    const normalizedScope = "https://desktop.example.test/";
    storage.set(`${STORAGE_PREFIX}${legacyScope}`, "legacy");
    storage.set(`${STORAGE_PREFIX}${normalizedScope}`, "normalized");
    storage.set(GLOBAL_STORAGE_KEY, "global");

    clearStoredBrowserDpopKey(legacyScope);

    expect(storage.get(`${STORAGE_PREFIX}${legacyScope}`)).toBeUndefined();
    expect(storage.get(`${STORAGE_PREFIX}${normalizedScope}`)).toBeUndefined();
    expect(storage.get(GLOBAL_STORAGE_KEY)).toBeUndefined();
  });
});
