import { describe, expect, it, vi } from "vitest";

import { createRendererRecoveryController } from "./rendererRecovery";

describe("renderer recovery", () => {
  it("schedules one recovery at a time", () => {
    let now = 1_000;
    let timer: unknown = null;
    const recover = vi.fn();
    const log = vi.fn();
    const runTimer = () => {
      expect(typeof timer).toBe("function");
      (timer as () => void)();
    };

    const controller = createRendererRecoveryController({
      cooldownMs: 250,
      maxRecoveries: 3,
      windowMs: 60_000,
      now: () => now,
      setTimeout: (callback) => {
        timer = callback;
        return callback;
      },
      clearTimeout: () => {
        timer = null;
      },
      log,
      recover,
    });

    expect(controller.schedule("render-process-gone")).toBe(true);
    expect(controller.schedule("did-fail-load")).toBe(false);
    expect(recover).not.toHaveBeenCalled();

    runTimer();

    expect(recover).toHaveBeenCalledTimes(1);

    now += 1_000;
    expect(controller.schedule("did-fail-load")).toBe(true);
  });

  it("stops recovery loops inside the configured window", () => {
    let now = 1_000;
    let timer: unknown = null;
    const recover = vi.fn();
    const log = vi.fn();
    const runTimer = () => {
      expect(typeof timer).toBe("function");
      (timer as () => void)();
    };

    const controller = createRendererRecoveryController({
      cooldownMs: 0,
      maxRecoveries: 2,
      windowMs: 5_000,
      now: () => now,
      setTimeout: (callback) => {
        timer = callback;
        return callback;
      },
      clearTimeout: () => {
        timer = null;
      },
      log,
      recover,
    });

    expect(controller.schedule("first")).toBe(true);
    runTimer();
    now += 1_000;
    expect(controller.schedule("second")).toBe(true);
    runTimer();
    now += 1_000;
    expect(controller.schedule("third")).toBe(false);
    expect(recover).toHaveBeenCalledTimes(2);

    now += 6_000;
    expect(controller.schedule("after-window")).toBe(true);
  });

  it("can cancel a pending recovery", () => {
    let timer: unknown = null;
    const recover = vi.fn();

    const controller = createRendererRecoveryController({
      cooldownMs: 250,
      maxRecoveries: 3,
      windowMs: 60_000,
      now: () => 1_000,
      setTimeout: (callback) => {
        timer = callback;
        return callback;
      },
      clearTimeout: () => {
        timer = null;
      },
      log: () => undefined,
      recover,
    });

    expect(controller.schedule("unresponsive")).toBe(true);
    controller.cancel("responsive");
    if (typeof timer === "function") {
      timer();
    }

    expect(recover).not.toHaveBeenCalled();
  });
});
