import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsError,
  type ServerSettings as ServerSettingsValue,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch, normalizeServerSettings } from "@t3tools/shared/serverSettings";
import {
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  SchemaIssue,
  ServiceMap,
  Stream,
} from "effect";

import { ServerConfig } from "./config";

export interface ServerSettingsShape {
  readonly start: Effect.Effect<void, ServerSettingsError>;
  readonly ready: Effect.Effect<void, ServerSettingsError>;
  readonly getSettings: Effect.Effect<ServerSettingsValue, ServerSettingsError>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettingsValue, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerSettingsValue>;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: Partial<ServerSettingsValue> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make(
          normalizeServerSettings({
            ...DEFAULT_SERVER_SETTINGS,
            ...overrides,
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              ...overrides.providers,
            },
          }),
        );
        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(settingsRef),
          updateSettings: (patch) =>
            Ref.get(settingsRef).pipe(
              Effect.flatMap((current) =>
                Schema.decodeUnknownEffect(ServerSettings)(
                  applyServerSettingsPatch(current, patch),
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({
                        settingsPath: "<memory>",
                        detail: SchemaIssue.makeFormatterDefault()(cause.issue),
                        cause,
                      }),
                  ),
                ),
              ),
              Effect.tap((next) => Ref.set(settingsRef, next)),
            ),
          streamChanges: Stream.empty,
        } satisfies ServerSettingsShape;
      }),
    );
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsRef = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const changes = yield* PubSub.unbounded<ServerSettingsValue>();

  const decodeSettings = (raw: string) =>
    Schema.decodeUnknownEffect(ServerSettings)(
      normalizeServerSettings(JSON.parse(raw) as Partial<ServerSettingsValue>),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: SchemaIssue.makeFormatterDefault()(cause.issue),
            cause,
          }),
      ),
    );

  const persistSettings = (settings: ServerSettingsValue) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              detail: "failed to prepare settings directory",
              cause,
            }),
        ),
      );
      yield* fs.writeFileString(settingsPath, `${JSON.stringify(settings, null, 2)}\n`).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              detail: "failed to write settings file",
              cause,
            }),
        ),
      );
    });

  const loadFromDisk = Effect.gen(function* () {
    const exists = yield* fs.exists(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to check settings file",
            cause,
          }),
      ),
    );
    if (!exists) {
      return DEFAULT_SERVER_SETTINGS;
    }
    const raw = yield* fs.readFileString(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to read settings file",
            cause,
          }),
      ),
    );
    return yield* decodeSettings(raw).pipe(Effect.map(normalizeServerSettings));
  });

  const start = loadFromDisk.pipe(
    Effect.tap((settings) => Ref.set(settingsRef, settings)),
    Effect.asVoid,
  );

  return {
    start,
    ready: Effect.void,
    getSettings: Ref.get(settingsRef),
    updateSettings: (patch) =>
      Ref.get(settingsRef).pipe(
        Effect.flatMap((current) =>
          Schema.decodeUnknownEffect(ServerSettings)(applyServerSettingsPatch(current, patch)).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  detail: SchemaIssue.makeFormatterDefault()(cause.issue),
                  cause,
                }),
            ),
          ),
        ),
        Effect.tap((next) => persistSettings(next)),
        Effect.tap((next) => Ref.set(settingsRef, next)),
        Effect.tap((next) => PubSub.publish(changes, next).pipe(Effect.asVoid)),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings);
