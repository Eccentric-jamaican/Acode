import { Option, Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const ComputerUseApprovalPolicy = Schema.Literals(["ask", "allow"]);
export type ComputerUseApprovalPolicy = typeof ComputerUseApprovalPolicy.Type;

export const ComputerUseAppCategory = Schema.Literals([
  "desktop",
  "agent",
  "system",
  "background",
  "other",
]);
export type ComputerUseAppCategory = typeof ComputerUseAppCategory.Type;

export const DEFAULT_COMPUTER_USE_APP_CATEGORIES: ReadonlyArray<ComputerUseAppCategory> = [
  "desktop",
  "system",
  "background",
  "other",
];

export const ComputerUseSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  approvalPolicy: ComputerUseApprovalPolicy.pipe(
    Schema.withConstructorDefault(() => Option.some("ask" as const)),
  ),
  enabledAppCategories: Schema.Array(ComputerUseAppCategory).pipe(
    Schema.withConstructorDefault(() => Option.some([...DEFAULT_COMPUTER_USE_APP_CATEGORIES])),
  ),
  allowedAppIds: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  blockedAppIds: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  captureRetentionDays: Schema.Number.pipe(Schema.withConstructorDefault(() => Option.some(7))),
});
export type ComputerUseSettings = typeof ComputerUseSettings.Type;

export const ComputerUseSettingsPatch = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  approvalPolicy: Schema.optional(ComputerUseApprovalPolicy),
  enabledAppCategories: Schema.optional(Schema.Array(ComputerUseAppCategory)),
  allowedAppIds: Schema.optional(Schema.Array(Schema.String)),
  blockedAppIds: Schema.optional(Schema.Array(Schema.String)),
  captureRetentionDays: Schema.optional(Schema.Number),
});
export type ComputerUseSettingsPatch = typeof ComputerUseSettingsPatch.Type;

export const ComputerUseWindowSummary = Schema.Struct({
  windowId: Schema.NullOr(Schema.Number),
  title: Schema.String,
  isMinimized: Schema.Boolean,
  isOnscreen: Schema.Boolean,
  isMain: Schema.Boolean,
  isFocused: Schema.Boolean,
});
export type ComputerUseWindowSummary = typeof ComputerUseWindowSummary.Type;

export const ComputerUseAppSummary = Schema.Struct({
  appId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  pid: Schema.Number,
  isRunning: Schema.optional(Schema.Boolean),
  isFrontmost: Schema.optional(Schema.Boolean),
  category: ComputerUseAppCategory.pipe(
    Schema.withConstructorDefault(() => Option.some("other" as const)),
  ),
  launchId: Schema.optional(Schema.String),
  iconUrl: Schema.optional(Schema.NullOr(Schema.String)),
  windows: Schema.Array(ComputerUseWindowSummary),
});
export type ComputerUseAppSummary = typeof ComputerUseAppSummary.Type;

export const ComputerUseAvailabilityStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type ComputerUseAvailabilityStatus = typeof ComputerUseAvailabilityStatus.Type;

export const ComputerUseListAppsInput = Schema.Struct({});
export type ComputerUseListAppsInput = typeof ComputerUseListAppsInput.Type;

export const ComputerUseListAppsResult = Schema.Struct({
  apps: Schema.Array(ComputerUseAppSummary),
  status: Schema.optional(ComputerUseAvailabilityStatus),
});
export type ComputerUseListAppsResult = typeof ComputerUseListAppsResult.Type;
