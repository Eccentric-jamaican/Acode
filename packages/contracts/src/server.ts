import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";
import {
  ErrorInboxEntry,
  ServerErrorInboxUpdatedPayload,
  ServerGetErrorInboxInput,
  ServerGetErrorInboxResult,
  ServerPromoteErrorInboxEntryToTaskInput,
  ServerPromoteErrorInboxEntryToTaskResult,
  ServerReportClientDiagnosticInput,
  ServerReportClientDiagnosticResult,
  ServerSetErrorInboxEntryResolutionInput,
  ServerSetErrorInboxEntryResolutionResult,
} from "./errorInbox";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerProviderAccountAuthMode = Schema.Literals([
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
]);
export type ServerProviderAccountAuthMode = typeof ServerProviderAccountAuthMode.Type;

export const ServerProviderPlanType = Schema.Literals([
  "free",
  "go",
  "plus",
  "pro",
  "team",
  "business",
  "enterprise",
  "edu",
  "unknown",
]);
export type ServerProviderPlanType = typeof ServerProviderPlanType.Type;

export const ServerProviderAccount = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("apiKey"),
  }),
  Schema.Struct({
    type: Schema.Literal("chatgpt"),
    email: TrimmedNonEmptyString,
    planType: ServerProviderPlanType,
  }),
]);
export type ServerProviderAccount = typeof ServerProviderAccount.Type;

export const ServerProviderRateLimitCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderRateLimitCredits = typeof ServerProviderRateLimitCredits.Type;

export const ServerProviderRateLimitWindow = Schema.Struct({
  usedPercent: Schema.Int,
  windowDurationMins: Schema.NullOr(Schema.Int),
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type ServerProviderRateLimitWindow = typeof ServerProviderRateLimitWindow.Type;

export const ServerProviderRateLimitBucket = Schema.Struct({
  limitId: Schema.NullOr(TrimmedNonEmptyString),
  limitName: Schema.NullOr(TrimmedNonEmptyString),
  planType: Schema.NullOr(ServerProviderPlanType),
  primary: Schema.NullOr(ServerProviderRateLimitWindow),
  secondary: Schema.NullOr(ServerProviderRateLimitWindow),
  credits: Schema.NullOr(ServerProviderRateLimitCredits),
});
export type ServerProviderRateLimitBucket = typeof ServerProviderRateLimitBucket.Type;

export const ServerProviderLoginState = Schema.Struct({
  status: Schema.Literals(["idle", "pending", "failed"]),
  loginId: Schema.NullOr(TrimmedNonEmptyString),
  authUrl: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderLoginState = typeof ServerProviderLoginState.Type;

export const ServerProviderAccountSummary = Schema.Struct({
  provider: ProviderKind,
  state: Schema.Literals(["loading", "authenticated", "unauthenticated", "error"]),
  authMode: Schema.NullOr(ServerProviderAccountAuthMode),
  requiresOpenaiAuth: Schema.NullOr(Schema.Boolean),
  account: Schema.NullOr(ServerProviderAccount),
  rateLimits: Schema.Array(ServerProviderRateLimitBucket),
  login: ServerProviderLoginState,
  message: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type ServerProviderAccountSummary = typeof ServerProviderAccountSummary.Type;

const ServerProviderAccounts = Schema.Array(ServerProviderAccountSummary);

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  providerAccounts: ServerProviderAccounts,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerStartProviderLoginInput = Schema.Struct({
  provider: Schema.Literal("codex"),
  type: Schema.Literal("chatgpt"),
});
export type ServerStartProviderLoginInput = typeof ServerStartProviderLoginInput.Type;

export const ServerStartProviderLoginResult = Schema.Struct({
  provider: Schema.Literal("codex"),
  loginId: TrimmedNonEmptyString,
  authUrl: TrimmedNonEmptyString,
});
export type ServerStartProviderLoginResult = typeof ServerStartProviderLoginResult.Type;

export const ServerCancelProviderLoginInput = Schema.Struct({
  provider: Schema.Literal("codex"),
  loginId: TrimmedNonEmptyString,
});
export type ServerCancelProviderLoginInput = typeof ServerCancelProviderLoginInput.Type;

export const ServerCancelProviderLoginResult = Schema.Struct({
  status: Schema.Literals(["canceled", "notFound"]),
});
export type ServerCancelProviderLoginResult = typeof ServerCancelProviderLoginResult.Type;

export const ServerLogoutProviderInput = Schema.Struct({
  provider: Schema.Literal("codex"),
});
export type ServerLogoutProviderInput = typeof ServerLogoutProviderInput.Type;

export const ServerLogoutProviderResult = Schema.Struct({});
export type ServerLogoutProviderResult = typeof ServerLogoutProviderResult.Type;

export const ServerNewThreadSuggestionCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
});
export type ServerNewThreadSuggestionCandidate = typeof ServerNewThreadSuggestionCandidate.Type;

export const ServerSuggestNewThreadTasksInput = Schema.Struct({
  provider: ProviderKind,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  selectedModel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ServerSuggestNewThreadTasksInput = typeof ServerSuggestNewThreadTasksInput.Type;

export const ServerSuggestNewThreadTasksResult = Schema.Struct({
  suggestions: Schema.Array(ServerNewThreadSuggestionCandidate),
});
export type ServerSuggestNewThreadTasksResult =
  typeof ServerSuggestNewThreadTasksResult.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerProviderStateUpdatedPayload = Schema.Struct({
  providers: ServerProviderStatuses,
  providerAccounts: ServerProviderAccounts,
});
export type ServerProviderStateUpdatedPayload = typeof ServerProviderStateUpdatedPayload.Type;

export {
  ErrorInboxEntry,
  ServerErrorInboxUpdatedPayload,
  ServerGetErrorInboxInput,
  ServerGetErrorInboxResult,
  ServerPromoteErrorInboxEntryToTaskInput,
  ServerPromoteErrorInboxEntryToTaskResult,
  ServerReportClientDiagnosticInput,
  ServerReportClientDiagnosticResult,
  ServerSetErrorInboxEntryResolutionInput,
  ServerSetErrorInboxEntryResolutionResult,
};
