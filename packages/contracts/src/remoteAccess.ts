import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const RemoteAccessPermission = Schema.Literals([
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
]);
export type RemoteAccessPermission = typeof RemoteAccessPermission.Type;

export const RemoteAccessPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  url: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  scopes: Schema.Array(RemoteAccessPermission),
  createdAt: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(TrimmedNonEmptyString),
});
export type RemoteAccessPairingLink = typeof RemoteAccessPairingLink.Type;

export const RemoteAccessClient = Schema.Struct({
  id: TrimmedNonEmptyString,
  sessionToken: Schema.optional(TrimmedNonEmptyString),
  label: TrimmedNonEmptyString,
  deviceType: TrimmedNonEmptyString,
  os: TrimmedNonEmptyString,
  client: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  scopes: Schema.Array(RemoteAccessPermission),
  isCurrent: Schema.Boolean,
  connected: Schema.Boolean,
});
export type RemoteAccessClient = typeof RemoteAccessClient.Type;

export const RemoteAccessSnapshot = Schema.Struct({
  networkAccessEnabled: Schema.Boolean,
  tailscaleHttpsEnabled: Schema.Boolean,
  tailscaleHttpsUrl: Schema.NullOr(Schema.String),
  pairingLinks: Schema.Array(RemoteAccessPairingLink),
  clients: Schema.Array(RemoteAccessClient),
  remoteEnvironments: Schema.Array(Schema.Unknown),
});
export type RemoteAccessSnapshot = typeof RemoteAccessSnapshot.Type;

export const RemoteAccessCreatePairingLinkInput = Schema.Struct({
  label: Schema.optional(Schema.String),
  scopes: Schema.Array(RemoteAccessPermission),
});
export type RemoteAccessCreatePairingLinkInput =
  typeof RemoteAccessCreatePairingLinkInput.Type;

export const RemoteAccessCreatePairingLinkResult = Schema.Struct({
  pairingLink: RemoteAccessPairingLink,
  snapshot: RemoteAccessSnapshot,
});
export type RemoteAccessCreatePairingLinkResult =
  typeof RemoteAccessCreatePairingLinkResult.Type;

export const RemoteAccessRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type RemoteAccessRevokePairingLinkInput = typeof RemoteAccessRevokePairingLinkInput.Type;

export const RemoteAccessRevokeClientInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type RemoteAccessRevokeClientInput = typeof RemoteAccessRevokeClientInput.Type;

export const RemoteAccessSetNetworkAccessInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type RemoteAccessSetNetworkAccessInput = typeof RemoteAccessSetNetworkAccessInput.Type;

export const RemoteAccessSetTailscaleHttpsInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type RemoteAccessSetTailscaleHttpsInput =
  typeof RemoteAccessSetTailscaleHttpsInput.Type;

export const RemoteAccessExchangePairingCodeInput = Schema.Struct({
  credential: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
  deviceType: Schema.optional(Schema.String),
  os: Schema.optional(Schema.String),
  client: Schema.optional(Schema.String),
});
export type RemoteAccessExchangePairingCodeInput =
  typeof RemoteAccessExchangePairingCodeInput.Type;

export const RemoteAccessExchangePairingCodeResult = Schema.Struct({
  sessionToken: TrimmedNonEmptyString,
  client: RemoteAccessClient,
  snapshot: RemoteAccessSnapshot,
});
export type RemoteAccessExchangePairingCodeResult =
  typeof RemoteAccessExchangePairingCodeResult.Type;
