import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("useSplitViewStore", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists files-only panel changes", async () => {
    const { useSplitViewStore } = await import("./splitViewStore");
    const splitViewId = useSplitViewStore.getState().createFromThread({
      sourceThreadId: ThreadId.makeUnsafe("thread-1"),
      ownerProjectId: ProjectId.makeUnsafe("project-1"),
    });

    useSplitViewStore.getState().setPanePanelState(splitViewId, "left", {
      filesOpen: true,
    });

    expect(useSplitViewStore.getState().splitViewsById[splitViewId]?.leftPanel.filesOpen).toBe(
      true,
    );

    useSplitViewStore.getState().setPanePanelState(splitViewId, "left", {
      filesOpen: false,
    });

    expect(useSplitViewStore.getState().splitViewsById[splitViewId]?.leftPanel.filesOpen).toBe(
      false,
    );
  });
});
