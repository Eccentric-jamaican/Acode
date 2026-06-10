import * as Schema from "effect/Schema";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export type ProviderReasoningEffort = CodexReasoningEffort | ClaudeCodeEffort;
export const OPENCODE_DEFAULT_MODEL_SLUG = "opencode/default" as const;
const MODEL_PROVIDER_KIND_SCHEMA = Schema.Literals(["codex", "opencode", "claudeAgent"]);

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const OpenCodeModelOptions = Schema.Struct({
  variant: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
});
export type OpenCodeModelOptions = typeof OpenCodeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  opencode: Schema.optional(OpenCodeModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  promptInjectedEffortLevels: Schema.Array(Schema.String),
  variantOptions: Schema.optional(Schema.Array(EffortOption)),
  agentOptions: Schema.optional(Schema.Array(EffortOption)),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

type ModelDefinition = {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
};

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    {
      slug: "gpt-5.5",
      name: "GPT-5.5",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium", isDefault: true },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.2",
      name: "GPT-5.2",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
  ],
  opencode: [
    {
      slug: OPENCODE_DEFAULT_MODEL_SLUG,
      name: "OpenCode Default",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "opencode-go/glm-5",
      name: "OpenCode Go GLM-5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "opencode-go/glm-5.1",
      name: "OpenCode Go GLM-5.1",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "opencode-go/kimi-k2.5",
      name: "OpenCode Go Kimi K2.5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "opencode-go/mimo-v2-pro",
      name: "OpenCode Go MiMo-V2-Pro",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "opencode-go/mimo-v2-omni",
      name: "OpenCode Go MiMo-V2-Omni",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "opencode-go/minimax-m2.7",
      name: "OpenCode Go MiniMax M2.7",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "opencode-go/minimax-m2.5",
      name: "OpenCode Go MiniMax M2.5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
  ],
  claudeAgent: [
    {
      slug: "claude-fable-5",
      name: "Claude Fable 5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
          { value: "max", label: "Max" },
          { value: "ultrathink", label: "Ultrathink" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: ["ultrathink"],
      },
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
          { value: "ultrathink", label: "Ultrathink" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: ["ultrathink"],
      },
    },
    {
      slug: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: true,
        promptInjectedEffortLevels: [],
      },
    },
  ],
} as const satisfies Record<ProviderKind, readonly ModelDefinition[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, ModelSlug> = {
  codex: "gpt-5.5",
  opencode: OPENCODE_DEFAULT_MODEL_SLUG,
  claudeAgent: "claude-sonnet-4-6",
};

// Backward compatibility for existing Codex-only call sites.
export const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER.codex;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;
export const DEFAULT_GIT_TEXT_GENERATION_MODEL = "gpt-5.4-mini" as const;

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, ModelSlug>> = {
  codex: {
    "5.5": "gpt-5.5",
    "5.4": "gpt-5.4",
    "5.4-mini": "gpt-5.4-mini",
    "gpt-5.4-mini": "gpt-5.4-mini",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  opencode: {
    default: OPENCODE_DEFAULT_MODEL_SLUG,
  },
  claudeAgent: {
    default: "claude-sonnet-4-6",
    fable: "claude-fable-5",
    "fable-5": "claude-fable-5",
    "claude-fable-5-latest": "claude-fable-5",
    opus: "claude-opus-4-8",
    "opus-4.8": "claude-opus-4-8",
    "claude-opus-4.8": "claude-opus-4-8",
    "claude-opus-4-8-latest": "claude-opus-4-8",
    "opus-4.7": "claude-opus-4-8",
    "claude-opus-4.7": "claude-opus-4-8",
    "claude-opus-4-7": "claude-opus-4-8",
    "claude-opus-4-7-latest": "claude-opus-4-8",
    "opus-4.6": "claude-opus-4-8",
    "claude-opus-4.6": "claude-opus-4-8",
    "claude-opus-4-6": "claude-opus-4-8",
    "claude-opus-4-6-20251117": "claude-opus-4-8",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-latest": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
};

// ── Model capabilities index ──────────────────────────────────────────

export const MODEL_CAPABILITIES_INDEX = Object.fromEntries(
  Object.entries(MODEL_OPTIONS_BY_PROVIDER).map(([provider, models]) => [
    provider,
    Object.fromEntries(models.map((m) => [m.slug, m.capabilities])),
  ]),
) as unknown as Record<ProviderKind, Record<string, ModelCapabilities>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  opencode: [],
  claudeAgent: [],
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "medium",
  opencode: null,
  claudeAgent: null,
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;

export const ModelSelection = Schema.Struct({
  provider: MODEL_PROVIDER_KIND_SCHEMA,
  model: Schema.String,
  options: Schema.optional(ProviderModelOptions),
});
export type ModelSelection = typeof ModelSelection.Type;

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  claudeAgent: "Claude Code",
};
