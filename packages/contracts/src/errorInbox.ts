import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const ErrorInboxSource = Schema.Literals([
  "provider-runtime",
  "provider-config",
  "provider-mcp",
  "server-internal",
  "browser-runtime",
  "browser-promise",
  "websocket",
]);
export type ErrorInboxSource = typeof ErrorInboxSource.Type;

export const ErrorInboxCategory = Schema.Literals([
  "provider",
  "mcp",
  "config",
  "orchestration",
  "websocket",
  "browser",
]);
export type ErrorInboxCategory = typeof ErrorInboxCategory.Type;

export const ErrorInboxSeverity = Schema.Literals(["error", "warning"]);
export type ErrorInboxSeverity = typeof ErrorInboxSeverity.Type;

export const ErrorInboxResolution = Schema.Literals(["ignored", "resolved"]);
export type ErrorInboxResolution = typeof ErrorInboxResolution.Type;

export const ErrorInboxEntryId = TrimmedNonEmptyString;
export type ErrorInboxEntryId = typeof ErrorInboxEntryId.Type;

export const ErrorInboxFingerprint = TrimmedNonEmptyString;
export type ErrorInboxFingerprint = typeof ErrorInboxFingerprint.Type;

export const ErrorInboxEntry = Schema.Struct({
  id: ErrorInboxEntryId,
  fingerprint: ErrorInboxFingerprint,
  source: ErrorInboxSource,
  category: ErrorInboxCategory,
  severity: ErrorInboxSeverity,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TurnId),
  provider: Schema.NullOr(ProviderKind),
  summary: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  latestContextJson: Schema.Unknown,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  occurrenceCount: NonNegativeInt,
  linkedTaskId: Schema.NullOr(TaskId),
  resolution: Schema.NullOr(ErrorInboxResolution),
});
export type ErrorInboxEntry = typeof ErrorInboxEntry.Type;

export const ErrorInboxOccurrenceLogRecord = Schema.Struct({
  entryId: ErrorInboxEntryId,
  fingerprint: ErrorInboxFingerprint,
  source: ErrorInboxSource,
  category: ErrorInboxCategory,
  severity: ErrorInboxSeverity,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TurnId),
  provider: Schema.NullOr(ProviderKind),
  summary: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  context: Schema.Unknown,
  occurredAt: IsoDateTime,
});
export type ErrorInboxOccurrenceLogRecord = typeof ErrorInboxOccurrenceLogRecord.Type;

export const ServerGetErrorInboxInput = Schema.Struct({});
export type ServerGetErrorInboxInput = typeof ServerGetErrorInboxInput.Type;

export const ServerGetErrorInboxResult = Schema.Array(ErrorInboxEntry);
export type ServerGetErrorInboxResult = typeof ServerGetErrorInboxResult.Type;

export const ServerReportClientDiagnosticInput = Schema.Struct({
  source: ErrorInboxSource,
  category: ErrorInboxCategory,
  severity: ErrorInboxSeverity,
  summary: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  turnId: Schema.optional(Schema.NullOr(TurnId)),
  provider: Schema.optional(Schema.NullOr(ProviderKind)),
  context: Schema.optional(Schema.Unknown),
  occurredAt: Schema.optional(IsoDateTime),
});
export type ServerReportClientDiagnosticInput = typeof ServerReportClientDiagnosticInput.Type;

export const ServerReportClientDiagnosticResult = Schema.Struct({
  entry: ErrorInboxEntry,
});
export type ServerReportClientDiagnosticResult = typeof ServerReportClientDiagnosticResult.Type;

export const ServerSetErrorInboxEntryResolutionInput = Schema.Struct({
  entryId: ErrorInboxEntryId,
  resolution: Schema.NullOr(ErrorInboxResolution),
});
export type ServerSetErrorInboxEntryResolutionInput =
  typeof ServerSetErrorInboxEntryResolutionInput.Type;

export const ServerSetErrorInboxEntryResolutionResult = Schema.Struct({
  entry: ErrorInboxEntry,
});
export type ServerSetErrorInboxEntryResolutionResult =
  typeof ServerSetErrorInboxEntryResolutionResult.Type;

export const ServerPromoteErrorInboxEntryToTaskInput = Schema.Struct({
  entryId: ErrorInboxEntryId,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type ServerPromoteErrorInboxEntryToTaskInput =
  typeof ServerPromoteErrorInboxEntryToTaskInput.Type;

export const ServerPromoteErrorInboxEntryToTaskResult = Schema.Struct({
  entry: ErrorInboxEntry,
  taskId: TaskId,
});
export type ServerPromoteErrorInboxEntryToTaskResult =
  typeof ServerPromoteErrorInboxEntryToTaskResult.Type;

export const ServerErrorInboxUpdatedReason = Schema.Literals([
  "upsert",
  "resolutionChanged",
  "linkedTask",
]);
export type ServerErrorInboxUpdatedReason = typeof ServerErrorInboxUpdatedReason.Type;

export const ServerErrorInboxUpdatedPayload = Schema.Struct({
  reason: ServerErrorInboxUpdatedReason,
  entry: ErrorInboxEntry,
});
export type ServerErrorInboxUpdatedPayload = typeof ServerErrorInboxUpdatedPayload.Type;
