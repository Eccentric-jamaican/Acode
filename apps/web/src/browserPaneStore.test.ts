import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "t3code:browser-pane:v1";
const storage = new Map<string, string>();

function getTestWindow(): Window & typeof globalThis {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
    localStorage?: Storage;
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  } satisfies Storage;

  if (!testGlobal.window) {
    testGlobal.window = { localStorage } as Window & typeof globalThis;
  } else {
    Object.assign(testGlobal.window, { localStorage });
  }
  testGlobal.localStorage = localStorage;
  return testGlobal.window;
}

beforeEach(() => {
  vi.resetModules();
  getTestWindow().localStorage.clear();
});

afterEach(() => {
  getTestWindow().localStorage.clear();
});

describe("browserPaneStore", () => {
  it("hydrates persisted width and clamps the initial width", async () => {
    getTestWindow().localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        width: 9_999,
      }),
    );

    const { useBrowserPaneStore } = await import("./browserPaneStore");

    expect(useBrowserPaneStore.getState().width).toBe(900);
  });

  it("persists clamped width updates", async () => {
    const { useBrowserPaneStore } = await import("./browserPaneStore");

    useBrowserPaneStore.getState().setWidth(10);

    expect(JSON.parse(getTestWindow().localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      width: 480,
    });
  });

  it("defaults to the widened pane width", async () => {
    const { useBrowserPaneStore } = await import("./browserPaneStore");

    expect(useBrowserPaneStore.getState().width).toBe(480);
  });
});
