import { Option, Schema } from "effect";

export const OpenCodeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  binaryPath: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("opencode"))),
  serverUrl: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some(""))),
  serverPassword: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some(""))),
  customModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ServerSettings = Schema.Struct({
  providers: Schema.Struct({
    opencode: OpenCodeSettings.pipe(Schema.withConstructorDefault(() => Option.some({}))),
  }).pipe(
    Schema.withConstructorDefault(() =>
      Option.some({
        opencode: OpenCodeSettings.makeUnsafe({}),
      }),
    ),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = ServerSettings.makeUnsafe({});

export const ServerSettingsPatch = Schema.Struct({
  providers: Schema.optional(
    Schema.Struct({
      opencode: Schema.optional(
        Schema.Struct({
          enabled: Schema.optional(Schema.Boolean),
          binaryPath: Schema.optional(Schema.String),
          serverUrl: Schema.optional(Schema.String),
          serverPassword: Schema.optional(Schema.String),
          customModels: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}
