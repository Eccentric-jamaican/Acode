import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { createOpencode, OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_SERVER_SETTINGS, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { Effect, Fiber, Layer, Stream } from "effect";

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

function createEventStream(
  events: ReadonlyArray<unknown>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let index = 0;
      return {
        next: async () => {
          if (index < events.length) {
            return { done: false, value: events[index++] };
          }
          return createAbortableStream(signal)[Symbol.asyncIterator]().next();
        },
      };
    },
  };
}

function createOpenCodeFixture(input?: {
  readonly commands?: ReadonlyArray<{ name: string; description?: string }>;
  readonly events?: ReadonlyArray<unknown>;
  readonly requireMethodThisBinding?: boolean;
}) {
  const commands = [...(input?.commands ?? [{ name: "review", description: "Run review checks" }])];
  const serverClose = vi.fn(() => undefined);
  const commandList = vi.fn(async function (
    this: { readonly commands?: typeof commands },
    _options?: unknown,
  ) {
    return this.commands ?? commands;
  });
  const sessionCreate = vi.fn(async function (
    this: { readonly sessionId?: string },
    _options?: unknown,
  ) {
    return { id: this.sessionId ?? "session-1" };
  });
  const sessionPromptAsync = vi.fn(async function (
    this: { readonly canPrompt?: boolean },
    _options?: unknown,
  ) {
    if (input?.requireMethodThisBinding && this.canPrompt !== true) {
      throw new Error("session.promptAsync lost method binding");
    }
    return undefined;
  });
  const sessionCommand = vi.fn(async function (
    this: { readonly canCommand?: boolean },
    _options?: {
      body?: {
        command?: string;
        arguments?: string;
        agent?: string;
        model?: string;
      };
      path?: { id?: string };
    },
  ) {
    if (input?.requireMethodThisBinding && this.canCommand !== true) {
      throw new Error("session.command lost method binding");
    }
    return { info: { id: "msg-1" }, parts: [] };
  });
  const eventSubscribe = vi.fn(async function (
    this: { readonly marker?: string },
    options?: { signal?: AbortSignal },
  ) {
    if (input?.requireMethodThisBinding && this.marker !== "event-api") {
      throw new Error("event.subscribe lost method binding");
    }
    return {
      stream: input?.events
        ? createEventStream(input.events, options?.signal)
        : createAbortableStream(options?.signal),
    };
  });
  const providerList = vi.fn(async function (this: { readonly marker?: string }) {
    if (input?.requireMethodThisBinding && this.marker !== "provider-api") {
      throw new Error("provider.list lost method binding");
    }
    return {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5": { id: "gpt-5", name: "GPT-5" },
          },
        },
      ],
      connected: ["openai"],
      default: {
        openai: "gpt-5",
      },
    };
  });

  const commandApi = input?.requireMethodThisBinding
    ? {
        commands,
        list: commandList,
      }
    : { list: commandList };

  const sessionApi = input?.requireMethodThisBinding
    ? {
        sessionId: "session-1",
        canPrompt: true,
        canCommand: true,
        create: sessionCreate,
        promptAsync: sessionPromptAsync,
        command: sessionCommand,
      }
    : {
        create: sessionCreate,
        promptAsync: sessionPromptAsync,
        command: sessionCommand,
      };

  const eventApi = input?.requireMethodThisBinding
    ? {
        marker: "event-api",
        subscribe: eventSubscribe,
      }
    : { subscribe: eventSubscribe };

  const providerApi = input?.requireMethodThisBinding
    ? {
        marker: "provider-api",
        list: providerList,
      }
    : { list: providerList };

  const createRuntimeImpl: typeof createOpencode = async () => ({
    server: { url: "http://127.0.0.1:43000", close: serverClose },
    client: {
      command: commandApi,
      session: sessionApi,
      event: eventApi,
      provider: providerApi,
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
    providerList,
    serverClose,
  };
}

async function runWithFixture<A, E>(
  fixture: ReturnType<typeof createOpenCodeFixture>,
  effect: Effect.Effect<A, E, OpencodeAdapter>,
  options?: {
    readonly settingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0];
    readonly stateDir?: string;
  },
): Promise<A> {
  const layer = makeOpencodeAdapterLive({
    createRuntime: fixture.createRuntime,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), options?.stateDir ?? process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest(options?.settingsOverrides)),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.orDie));
}

describe("OpencodeAdapter native commands", () => {
  it("discovers commands from SDK with cache and forceReload behavior", async () => {
    const fixture = createOpenCodeFixture({
      commands: [{ name: "review", description: "Run review checks" }, { name: "init" }],
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
      expect((result.failure as { issue?: string }).issue).toContain("do not support attachments");
    }
    expect(fixture.sessionPromptAsync).not.toHaveBeenCalled();
    expect(fixture.sessionCommand).not.toHaveBeenCalled();
  });

  it("preserves a blank OpenCode binary path when settings persist an empty value", async () => {
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
        binaryPath: "",
      }),
    );
  });

  it("binds injected SDK methods to their owning objects", async () => {
    const fixture = createOpenCodeFixture({
      requireMethodThisBinding: true,
    });
    const events: ProviderRuntimeEvent[] = [];

    await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkChild);

        try {
          const threadId = asThreadId("thread-bound-methods");
          yield* adapter.startSession({
            threadId,
            provider: "opencode",
            cwd: process.cwd(),
            model: "openai/gpt-4.1",
            runtimeMode: "full-access",
          });

          if (!adapter.listCommands) {
            throw new Error("OpenCode adapter did not expose listCommands.");
          }

          const commands = yield* adapter.listCommands({
            provider: "opencode",
            cwd: process.cwd(),
          });

          expect(commands.commands).toEqual([{ name: "review", description: "Run review checks" }]);

          if (!adapter.listModels) {
            throw new Error("OpenCode adapter did not expose listModels.");
          }

          const models = yield* adapter.listModels();
          expect(models.models).toEqual([{ slug: "openai/gpt-5", name: "OpenAI · GPT-5" }]);

          yield* adapter.sendTurn({
            threadId,
            input: "/review check binding",
          });

          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
          yield* adapter.stopAll();
        } finally {
          yield* Fiber.interrupt(collector);
        }
      }),
    );

    expect(fixture.sessionCreate).toHaveBeenCalledTimes(1);
    expect(fixture.commandList).toHaveBeenCalledTimes(1);
    expect(fixture.providerList).toHaveBeenCalledTimes(1);
    expect(fixture.sessionCommand).toHaveBeenCalledTimes(1);
    expect(fixture.eventSubscribe).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "runtime.warning")).toBe(false);
  });

  it("surfaces OpenCode Question tool parts as answerable user input", async () => {
    const fixture = createOpenCodeFixture({
      events: [
        {
          type: "message.part.updated",
          properties: {
            sessionID: "session-1",
            part: {
              id: "part-question-1",
              messageID: "message-1",
              role: "assistant",
              type: "tool",
              tool: "Question",
              callID: "question-request-1",
              state: {
                status: "running",
                input: {
                  questions: [
                    {
                      header: "Scope",
                      question: "Which documents should be included?",
                      options: [
                        "All documents",
                        { label: "Core documents", description: "Only the primary policies" },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    });
    const events: ProviderRuntimeEvent[] = [];

    await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkChild);

        try {
          yield* adapter.startSession({
            threadId: asThreadId("thread-question-tool"),
            provider: "opencode",
            cwd: process.cwd(),
            model: "openai/gpt-4.1",
            runtimeMode: "full-access",
          });
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
          yield* adapter.stopAll();
        } finally {
          yield* Fiber.interrupt(collector);
        }
      }),
    );

    const userInput = events.find((event) => event.type === "user-input.requested");
    expect(userInput?.requestId).toBe("question-request-1");
    expect(userInput?.payload).toEqual({
      questions: [
        {
          id: "question-0-scope",
          header: "Scope",
          question: "Which documents should be included?",
          options: [
            { label: "All documents", description: "All documents" },
            { label: "Core documents", description: "Only the primary policies" },
          ],
        },
      ],
    });
    expect(
      events.some(
        (event) =>
          (event.type === "item.started" || event.type === "item.updated") &&
          event.requestId === "question-request-1",
      ),
    ).toBe(false);
  });

  it("relocates bridged computer-use captures from shared OpenCode storage to the T3 thread", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-opencode-captures-"));
    const sharedCapturePath = path.join(
      stateDir,
      "attachments",
      "computer-use",
      "opencode",
      "captures",
      "capture-1.png",
    );
    fs.mkdirSync(path.dirname(sharedCapturePath), { recursive: true });
    fs.writeFileSync(sharedCapturePath, Buffer.from("png"));

    const structuredContent = {
      tool: "screenshot",
      captures: [
        {
          captureId: "capture-1",
          mimeType: "image/png",
          url: "/attachments/computer-use/opencode/captures/capture-1.png",
          path: sharedCapturePath,
          width: 100,
          height: 80,
        },
      ],
    };
    const fixture = createOpenCodeFixture({
      events: [
        {
          type: "message.part.updated",
          properties: {
            sessionID: "session-1",
            part: {
              id: "part-computer-1",
              messageID: "message-1",
              role: "assistant",
              type: "tool",
              tool: "t3_computer_screenshot",
              callID: "tool-call-1",
              state: {
                status: "completed",
                output: `Captured screenshot.\n\n<t3_computer_result>${JSON.stringify(
                  structuredContent,
                )}</t3_computer_result>`,
              },
            },
          },
        },
      ],
    });
    const events: ProviderRuntimeEvent[] = [];
    const threadId = asThreadId("thread-computer-captures");

    await runWithFixture(
      fixture,
      Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkChild);

        try {
          yield* adapter.startSession({
            threadId,
            provider: "opencode",
            cwd: process.cwd(),
            model: "openai/gpt-4.1",
            runtimeMode: "full-access",
          });
          yield* Effect.promise(async () => {
            for (let index = 0; index < 40; index += 1) {
              if (
                events.some(
                  (event) => event.type === "item.completed" && event.itemId === "tool-call-1",
                )
              ) {
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          });
          yield* adapter.stopAll();
        } finally {
          yield* Fiber.interrupt(collector);
        }
      }),
      { stateDir },
    );

    const completed = events.find(
      (event) => event.type === "item.completed" && event.itemId === "tool-call-1",
    );
    const payload = completed?.payload as unknown as
      | { data?: { structuredContent?: { captures?: Array<{ url?: string; path?: string }> } } }
      | undefined;
    const data = payload?.data as
      | { structuredContent?: { captures?: Array<{ url?: string; path?: string }> } }
      | undefined;
    const capture = data?.structuredContent?.captures?.[0];
    const expectedRelativePath = "computer-use/thread-computer-captures/captures/capture-1.png";
    const expectedPath = path.join(stateDir, "attachments", ...expectedRelativePath.split("/"));

    expect(capture?.url).toBe(`/attachments/${expectedRelativePath}`);
    expect(capture?.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(sharedCapturePath)).toBe(false);
  });
});
