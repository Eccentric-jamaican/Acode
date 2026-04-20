import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { createOpencode, OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpencodeAdapter } from "../Services/OpencodeAdapter.ts";
import { makeOpencodeAdapterLive } from "./OpencodeAdapter.ts";

function asThreadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function createAbortableStream(signal?: AbortSignal): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: async () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            if (!signal || signal.aborted) {
              resolve({ done: true, value: undefined });
              return;
            }
            const onAbort = () => resolve({ done: true, value: undefined });
            signal.addEventListener("abort", onAbort, { once: true });
          }),
      };
    },
  };
}

function createOpenCodeFixture(input?: {
  readonly commands?: ReadonlyArray<{ name: string; description?: string }>;
}) {
  const commands = [...(input?.commands ?? [{ name: "review", description: "Run review checks" }])];
  const serverClose = vi.fn(() => undefined);
  const commandList = vi.fn(async (_options?: unknown) => commands);
  const sessionCreate = vi.fn(async (_options?: unknown) => ({ id: "session-1" }));
  const sessionPromptAsync = vi.fn(async (_options?: unknown) => undefined);
  const sessionCommand = vi.fn(
    async (_options?: {
      body?: {
        command?: string;
        arguments?: string;
        agent?: string;
        model?: string;
      };
      path?: { id?: string };
    }) => ({ info: { id: "msg-1" }, parts: [] }),
  );
  const eventSubscribe = vi.fn(
    async (options?: { signal?: AbortSignal }) => ({
      stream: createAbortableStream(options?.signal),
    }),
  );

  const createRuntimeImpl: typeof createOpencode = async () => ({
    server: { url: "http://127.0.0.1:43000", close: serverClose },
    client: {
      command: { list: commandList },
      session: {
        create: sessionCreate,
        promptAsync: sessionPromptAsync,
        command: sessionCommand,
      },
      event: { subscribe: eventSubscribe },
    } as unknown as OpencodeClient,
  });
  const createRuntime = vi.fn(createRuntimeImpl);

  return {
    createRuntime,
    commandList,
    sessionCreate,
    sessionPromptAsync,
    sessionCommand,
    eventSubscribe,
    serverClose,
  };
}

async function runWithFixture<A, E>(
  fixture: ReturnType<typeof createOpenCodeFixture>,
  effect: Effect.Effect<A, E, OpencodeAdapter>,
  options?: {
    readonly settingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0];
  },
): Promise<A> {
  const layer = makeOpencodeAdapterLive({
    createRuntime: fixture.createRuntime,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest(options?.settingsOverrides)),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.orDie));
}

describe("OpencodeAdapter native commands", () => {
  it("discovers commands from SDK with cache and forceReload behavior", async () => {
    const fixture = createOpenCodeFixture({
      commands: [
        { name: "review", description: "Run review checks" },
        { name: "init" },
      ],
    });

    const result = await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        if (!adapter.listCommands) {
          throw new Error("OpenCode adapter did not expose listCommands.");
        }
        const first = yield* adapter.listCommands({
          provider: "opencode",
          cwd: "C:\\repo",
        });
        const second = yield* adapter.listCommands({
          provider: "opencode",
          cwd: "C:\\repo",
        });
        const third = yield* adapter.listCommands({
          provider: "opencode",
          cwd: "C:\\repo",
          forceReload: true,
        });
        return { first, second, third };
      }),
    );

    expect(result.first.source).toBe("opencodeSdk");
    expect(result.first.cached).toBe(false);
    expect(result.first.commands).toEqual([
      { name: "review", description: "Run review checks" },
      { name: "init" },
    ]);
    expect(result.second.cached).toBe(true);
    expect(result.third.cached).toBe(false);
    expect(fixture.commandList).toHaveBeenCalledTimes(2);
  });

  it("routes leading slash turns to session.command and keeps non-slash turns on prompt_async", async () => {
    const fixture = createOpenCodeFixture();

    await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const threadId = asThreadId("thread-routing");
        yield* adapter.startSession({
          threadId,
          provider: "opencode",
          cwd: process.cwd(),
          model: "openai/gpt-4.1",
          runtimeMode: "full-access",
        });

        const slashTurn = yield* adapter.sendTurn({
          threadId,
          input: "/review quick pass",
        });
        assert.ok(slashTurn.turnId);

        const promptTurn = yield* adapter.sendTurn({
          threadId,
          input: "hello world",
        });
        assert.ok(promptTurn.turnId);
      }),
    );

    expect(fixture.sessionCommand).toHaveBeenCalledTimes(1);
    expect(fixture.sessionPromptAsync).toHaveBeenCalledTimes(1);
    expect(fixture.sessionCommand.mock.calls[0]?.[0]).toMatchObject({
      path: { id: "session-1" },
      body: {
        command: "review",
        arguments: "quick pass",
        model: "openai/gpt-4.1",
      },
    });
  });

  it("returns validation error for unknown leading slash command", async () => {
    const fixture = createOpenCodeFixture({
      commands: [{ name: "review" }],
    });

    const result = await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const threadId = asThreadId("thread-unknown");
        yield* adapter.startSession({
          threadId,
          provider: "opencode",
          cwd: process.cwd(),
          model: "openai/gpt-4.1",
          runtimeMode: "full-access",
        });
        return yield* adapter
          .sendTurn({
            threadId,
            input: "/does-not-exist argument",
          })
          .pipe(Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("ProviderAdapterValidationError");
      expect((result.failure as { issue?: string }).issue).toContain(
        "Unknown OpenCode slash command",
      );
    }
    expect(fixture.sessionPromptAsync).not.toHaveBeenCalled();
    expect(fixture.sessionCommand).not.toHaveBeenCalled();
  });

  it("returns validation error for slash command turns with attachments", async () => {
    const fixture = createOpenCodeFixture();

    const result = await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const threadId = asThreadId("thread-attachments");
        yield* adapter.startSession({
          threadId,
          provider: "opencode",
          cwd: process.cwd(),
          model: "openai/gpt-4.1",
          runtimeMode: "full-access",
        });
        return yield* adapter
          .sendTurn({
            threadId,
            input: "/review",
            attachments: [
              {
                type: "image",
                id: "att-1",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("ProviderAdapterValidationError");
      expect((result.failure as { issue?: string }).issue).toContain(
        "do not support attachments",
      );
    }
    expect(fixture.sessionPromptAsync).not.toHaveBeenCalled();
    expect(fixture.sessionCommand).not.toHaveBeenCalled();
  });

  it("falls back to the default OpenCode binary path when settings persist an empty value", async () => {
    const fixture = createOpenCodeFixture();

    await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const threadId = asThreadId("thread-empty-binary");
        yield* adapter.startSession({
          threadId,
          provider: "opencode",
          cwd: process.cwd(),
          model: "openai/gpt-4.1",
          runtimeMode: "full-access",
        });
      }),
      {
        settingsOverrides: {
          providers: {
            opencode: {
              ...DEFAULT_SERVER_SETTINGS.providers.opencode,
              binaryPath: "",
            },
          },
        },
      },
    );

    expect(fixture.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: "opencode",
      }),
    );
  });
});
