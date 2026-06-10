import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const ProviderUpdateCommandId = Schema.Literals(["npm", "pnpm", "brew"]);
export type ProviderUpdateCommandId = typeof ProviderUpdateCommandId.Type;

export const ProviderUpdateCommand = Schema.Struct({
  id: ProviderUpdateCommandId,
  label: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
});
export type ProviderUpdateCommand = typeof ProviderUpdateCommand.Type;

export const ProviderUpdateVerification = Schema.Struct({
  trusted: Schema.Boolean,
  publisher: Schema.NullOr(TrimmedNonEmptyString),
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUpdateVerification = typeof ProviderUpdateVerification.Type;

export const ServerProviderUpdateInfo = Schema.Struct({
  packageName: TrimmedNonEmptyString,
  homepageUrl: Schema.optional(TrimmedNonEmptyString),
  repositoryUrl: Schema.optional(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  currentVersion: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updateAvailable: Schema.Boolean,
  fetchedAt: IsoDateTime,
  verification: ProviderUpdateVerification,
  commands: Schema.Array(ProviderUpdateCommand),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUpdateInfo = typeof ServerProviderUpdateInfo.Type;

const ProviderUpdateConfig = Schema.Struct({
  packageName: TrimmedNonEmptyString,
  trustedRepositoryOwners: Schema.Array(TrimmedNonEmptyString),
  trustedNpmEmailDomains: Schema.Array(TrimmedNonEmptyString),
  trustedNpmMaintainers: Schema.Array(TrimmedNonEmptyString),
  commands: Schema.Array(ProviderUpdateCommand),
  homepageUrl: TrimmedNonEmptyString,
  repositoryUrl: TrimmedNonEmptyString,
  repositoryOwner: TrimmedNonEmptyString,
  repositoryName: TrimmedNonEmptyString,
});
export type ProviderUpdateConfig = typeof ProviderUpdateConfig.Type;

export const PROVIDER_UPDATE_CONFIG: Readonly<Record<ProviderKind, ProviderUpdateConfig>> = {
  codex: {
    packageName: "@openai/codex",
    trustedRepositoryOwners: ["openai"],
    trustedNpmEmailDomains: ["openai.com"],
    trustedNpmMaintainers: [],
    commands: [
      { id: "npm", label: "npm", command: "npm install -g @openai/codex@latest" },
      { id: "pnpm", label: "pnpm", command: "pnpm add -g @openai/codex@latest" },
      { id: "brew", label: "brew", command: "brew upgrade codex" },
    ],
    homepageUrl: "https://github.com/openai/codex",
    repositoryUrl: "https://github.com/openai/codex",
    repositoryOwner: "openai",
    repositoryName: "codex",
  },
  opencode: {
    packageName: "opencode-ai",
    trustedRepositoryOwners: ["sst"],
    trustedNpmEmailDomains: [],
    trustedNpmMaintainers: ["thdxr"],
    commands: [
      { id: "npm", label: "npm", command: "npm install -g opencode-ai@latest" },
      { id: "pnpm", label: "pnpm", command: "pnpm add -g opencode-ai@latest" },
      { id: "brew", label: "brew", command: "brew upgrade opencode" },
    ],
    homepageUrl: "https://github.com/sst/opencode",
    repositoryUrl: "https://github.com/sst/opencode",
    repositoryOwner: "sst",
    repositoryName: "opencode",
  },
  claudeAgent: {
    packageName: "@anthropic-ai/claude-code",
    trustedRepositoryOwners: ["anthropics"],
    trustedNpmEmailDomains: ["anthropic.com"],
    trustedNpmMaintainers: [],
    commands: [
      {
        id: "npm",
        label: "npm",
        command: "npm install -g @anthropic-ai/claude-code@latest",
      },
      {
        id: "pnpm",
        label: "pnpm",
        command: "pnpm add -g @anthropic-ai/claude-code@latest",
      },
      { id: "brew", label: "brew", command: "brew upgrade claude-code" },
    ],
    homepageUrl: "https://github.com/anthropics/claude-code",
    repositoryUrl: "https://github.com/anthropics/claude-code",
    repositoryOwner: "anthropics",
    repositoryName: "claude-code",
  },
};
