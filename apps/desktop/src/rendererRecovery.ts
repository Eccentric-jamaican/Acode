export interface RendererRecoveryControllerOptions {
  readonly cooldownMs: number;
  readonly maxRecoveries: number;
  readonly windowMs: number;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly log: (message: string) => void;
  readonly recover: () => void;
}

export interface RendererRecoveryController {
  readonly schedule: (reason: string) => boolean;
  readonly cancel: (reason: string) => void;
}

export function createRendererRecoveryController(
  options: RendererRecoveryControllerOptions,
): RendererRecoveryController {
  let pendingTimer: unknown = null;
  let recoveryTimestamps: number[] = [];

  const pruneRecoveries = (timestamp: number) => {
    const earliest = timestamp - options.windowMs;
    recoveryTimestamps = recoveryTimestamps.filter((entry) => entry >= earliest);
  };

  return {
    schedule(reason) {
      const timestamp = options.now();
      pruneRecoveries(timestamp);
      if (recoveryTimestamps.length >= options.maxRecoveries) {
        options.log(
          `renderer recovery suppressed reason=${reason} count=${recoveryTimestamps.length} windowMs=${options.windowMs}`,
        );
        return false;
      }

      if (pendingTimer !== null) {
        options.log(`renderer recovery already pending reason=${reason}`);
        return false;
      }

      recoveryTimestamps = [...recoveryTimestamps, timestamp];
      options.log(`renderer recovery scheduled reason=${reason} cooldownMs=${options.cooldownMs}`);
      pendingTimer = options.setTimeout(() => {
        pendingTimer = null;
        options.log(`renderer recovery running reason=${reason}`);
        options.recover();
      }, options.cooldownMs);
      return true;
    },
    cancel(reason) {
      if (pendingTimer === null) {
        return;
      }
      options.clearTimeout(pendingTimer);
      pendingTimer = null;
      options.log(`renderer recovery canceled reason=${reason}`);
    },
  };
}
