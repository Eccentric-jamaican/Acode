import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ErrorInboxService } from "../Services/ErrorInbox.ts";
import { ErrorInboxRepositoryLive } from "./ErrorInboxRepository.ts";
import { ErrorInboxServiceLive } from "./ErrorInbox.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ONE_ID = ThreadId.makeUnsafe("thread-1");
const THREAD_TWO_ID = ThreadId.makeUnsafe("thread-2");

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-03-22T19:00:00.000Z",
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5-codex",
        createdAt: "2026-03-22T19:00:00.000Z",
        updatedAt: "2026-03-22T19:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [
      {
        id: THREAD_ONE_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Thread one",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-03-22T19:00:00.000Z",
        updatedAt: "2026-03-22T19:00:00.000Z",
        deletedAt: null,
        isPinned: false,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      },
      {
        id: THREAD_TWO_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Thread two",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-03-22T19:00:00.000Z",
        updatedAt: "2026-03-22T19:00:00.000Z",
        deletedAt: null,
        isPinned: false,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

function makeServerConfig(stateDir: string): ServerConfigShape {
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: stateDir,
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    settingsPath: path.join(stateDir, "settings.json"),
    providerStatusCacheDir: path.join(stateDir, "provider-status"),
    stateDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
  } satisfies ServerConfigShape;
}

function makeErrorInboxLayer(input: {
  readonly stateDir: string;
  readonly readModel?: OrchestrationReadModel;
}) {
  const dbPath = path.join(input.stateDir, "state.sqlite");
  const dispatchSpy = vi.fn((command: OrchestrationCommand) => command);
  const orchestrationEngineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () => Effect.succeed(input.readModel ?? makeReadModel()),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatchSpy(command);
        return { sequence: dispatchSpy.mock.calls.length };
      }),
    streamDomainEvents: Stream.empty,
  } satisfies OrchestrationEngineShape);

  return {
    dispatchSpy,
    layer: ErrorInboxServiceLive.pipe(
      Layer.provide(ErrorInboxRepositoryLive),
      Layer.provide(orchestrationEngineLayer),
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
      Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfig(input.stateDir))),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("ErrorInboxServiceLive", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("dedupes captures across threads, writes occurrence logs, and publishes updates", async () => {
    const stateDir = makeTempDir("t3-error-inbox-");
    const { layer } = makeErrorInboxLayer({ stateDir });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const errorInbox = yield* ErrorInboxService;
        const updateFiber = yield* Stream.runHead(errorInbox.updates).pipe(Effect.forkChild);

        const first = yield* errorInbox.capture({
          source: "provider-runtime",
          category: "provider",
          severity: "error",
          summary: "Codex session failed to start",
          detail: "spawn ENOENT in /tmp/ws-project-a",
          threadId: THREAD_ONE_ID,
          provider: "codex",
          context: {
            method: "session/startFailed",
            path: "/tmp/ws-project-a",
          },
          occurredAt: "2026-03-22T19:01:00.000Z",
        });

        const update = yield* Fiber.join(updateFiber);

        const second = yield* errorInbox.capture({
          source: "provider-runtime",
          category: "provider",
          severity: "error",
          summary: "Codex session failed to start",
          detail: "spawn ENOENT in /tmp/ws-project-b",
          threadId: THREAD_TWO_ID,
          provider: "codex",
          context: {
            method: "session/startFailed",
            path: "/tmp/ws-project-b",
          },
          occurredAt: "2026-03-22T19:02:00.000Z",
        });

        const listed = yield* errorInbox.listEntries();

        return {
          first,
          second,
          listed,
          update,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.update?._tag).toBe("Some");
    if (result.update?._tag === "Some") {
      expect(result.update.value.reason).toBe("upsert");
      expect(result.update.value.entry.summary).toBe("Codex session failed to start");
    }

    expect(result.first.projectId).toBe(PROJECT_ID);
    expect(result.second.id).toBe(result.first.id);
    expect(result.second.threadId).toBe(THREAD_TWO_ID);
    expect(result.second.occurrenceCount).toBe(2);
    expect(result.second.firstSeenAt).toBe("2026-03-22T19:01:00.000Z");
    expect(result.second.lastSeenAt).toBe("2026-03-22T19:02:00.000Z");
    expect(result.listed).toHaveLength(1);
    expect(result.listed[0]?.occurrenceCount).toBe(2);

    const logPath = path.join(stateDir, "logs", "error-inbox.ndjson");
    const logLines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(logLines).toHaveLength(2);
    expect(logLines.map((line) => JSON.parse(line).entryId)).toEqual([
      result.first.id,
      result.first.id,
    ]);
  });

  it("updates resolution and promotes entries into backlog tasks", async () => {
    const stateDir = makeTempDir("t3-error-inbox-promote-");
    const { layer, dispatchSpy } = makeErrorInboxLayer({ stateDir });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const errorInbox = yield* ErrorInboxService;

        const entry = yield* errorInbox.capture({
          source: "provider-mcp",
          category: "mcp",
          severity: "warning",
          summary: "MCP OAuth failed: github",
          detail: "invalid_grant",
          threadId: THREAD_ONE_ID,
          provider: "codex",
          context: {
            method: "mcpServer/oauthLogin/completed",
            name: "github",
          },
          occurredAt: "2026-03-22T19:03:00.000Z",
        });

        const resolved = yield* errorInbox.setResolution(entry.id, "ignored");
        const promoted = yield* errorInbox.promoteToTask({
          entryId: entry.id,
        });

        return {
          entry,
          resolved,
          promoted,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.resolved.resolution).toBe("ignored");
    expect(result.promoted.entry.linkedTaskId).toBe(result.promoted.taskId);
    expect(result.promoted.entry.projectId).toBe(PROJECT_ID);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    const command = dispatchSpy.mock.calls[0]?.[0];
    expect(command?.type).toBe("task.create");
    if (command?.type === "task.create") {
      expect(command.projectId).toBe(PROJECT_ID);
      expect(command.title).toBe("[Error] MCP OAuth failed: github");
      expect(command.state).toBe("backlog");
      expect(command.acceptanceCriteria).toContain("bun lint passes");
      expect(command.acceptanceCriteria).toContain("bun typecheck passes");
    }
  });
});
