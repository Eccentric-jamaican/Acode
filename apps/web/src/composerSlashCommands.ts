import type { ProviderKind } from "@t3tools/contracts";

export const BUILT_IN_COMPOSER_SLASH_COMMANDS = [
  "clear",
  "model",
  "plan",
  "default",
  "review",
  "fork",
  "status",
  "browser",
  "subagents",
  "fast",
] as const;

export type ComposerSlashCommand = (typeof BUILT_IN_COMPOSER_SLASH_COMMANDS)[number];

export interface ComposerSlashCommandDefinition {
  command: ComposerSlashCommand;
  label: `/${ComposerSlashCommand}`;
  description: string;
  source: "app" | "shared";
}

const COMPOSER_SLASH_COMMAND_DEFINITIONS: Record<
  ComposerSlashCommand,
  ComposerSlashCommandDefinition
> = {
  clear: {
    command: "clear",
    label: "/clear",
    description: "Start a fresh thread and clear the current conversation context",
    source: "shared",
  },
  model: {
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
    source: "shared",
  },
  plan: {
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
    source: "app",
  },
  default: {
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal chat mode",
    source: "app",
  },
  review: {
    command: "review",
    label: "/review",
    description: "Start a code review for current changes",
    source: "app",
  },
  fork: {
    command: "fork",
    label: "/fork",
    description: "Fork this thread into local or a new worktree",
    source: "app",
  },
  status: {
    command: "status",
    label: "/status",
    description: "Show context usage and rate-limit status",
    source: "app",
  },
  browser: {
    command: "browser",
    label: "/browser",
    description: "Insert a prompt for the T3 in-app browser",
    source: "app",
  },
  subagents: {
    command: "subagents",
    label: "/subagents",
    description: "Insert a prompt that asks Codex to delegate work",
    source: "app",
  },
  fast: {
    command: "fast",
    label: "/fast",
    description: "Turn fast mode on or off for this thread",
    source: "app",
  },
};

const CLAUDE_NATIVE_COMMAND_ALIASES: Record<string, readonly string[]> = {
  clear: ["reset", "new"],
  config: ["settings"],
  desktop: ["app"],
  exit: ["quit"],
  feedback: ["bug"],
  branch: ["fork"],
  mobile: ["ios", "android"],
  permissions: ["allowed-tools"],
  "remote-control": ["rc"],
  resume: ["continue"],
};

function normalizeSlashCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

function getProviderNativeSlashCommandAliases(
  provider: ProviderKind,
  command: string,
): readonly string[] {
  if (provider !== "claudeAgent") {
    return [];
  }
  return CLAUDE_NATIVE_COMMAND_ALIASES[normalizeSlashCommandName(command)] ?? [];
}

function expandProviderNativeSlashCommandNames(
  provider: ProviderKind,
  commandNames: ReadonlyArray<string>,
): string[] {
  const expandedNames = new Set<string>();
  for (const commandName of commandNames) {
    const normalizedCommandName = normalizeSlashCommandName(commandName);
    if (!normalizedCommandName) {
      continue;
    }
    expandedNames.add(normalizedCommandName);
    for (const alias of getProviderNativeSlashCommandAliases(provider, normalizedCommandName)) {
      expandedNames.add(alias);
    }
  }
  return [...expandedNames];
}

export function getProviderNativeSlashCommandSearchTerms(
  provider: ProviderKind,
  command: string,
): readonly string[] {
  const normalizedCommand = normalizeSlashCommandName(command);
  return [normalizedCommand, ...getProviderNativeSlashCommandAliases(provider, normalizedCommand)];
}

export function hasProviderNativeSlashCommand(
  provider: ProviderKind,
  commandNames: ReadonlyArray<string>,
  command: string,
): boolean {
  return expandProviderNativeSlashCommandNames(provider, commandNames).includes(
    normalizeSlashCommandName(command),
  );
}

export function getAvailableComposerSlashCommands(input: {
  provider: ProviderKind;
  supportsFastSlashCommand?: boolean;
  canOfferReviewCommand?: boolean;
  canOfferForkCommand?: boolean;
  providerNativeCommandNames?: ReadonlyArray<string>;
}): ComposerSlashCommand[] {
  const collidingNativeCommandNames = new Set<ComposerSlashCommand>(
    expandProviderNativeSlashCommandNames(
      input.provider,
      input.providerNativeCommandNames ?? [],
    ).filter((name): name is ComposerSlashCommand => isBuiltInComposerSlashCommand(name)),
  );
  const supportsFastSlashCommand = input.supportsFastSlashCommand ?? true;
  const canOfferReviewCommand = input.canOfferReviewCommand ?? true;
  const canOfferForkCommand = input.canOfferForkCommand ?? true;
  const availableCommands: ComposerSlashCommand[] =
    input.provider === "codex" || input.provider === "opencode"
      ? [
          "clear",
          "model",
          ...(input.provider === "codex" && supportsFastSlashCommand ? (["fast"] as const) : []),
          "plan",
          "default",
          ...(canOfferReviewCommand ? (["review"] as const) : []),
          ...(canOfferForkCommand ? (["fork"] as const) : []),
          "status",
          "browser",
          "subagents",
        ]
      : [];

  return availableCommands.filter((command) => !collidingNativeCommandNames.has(command));
}

export function isBuiltInComposerSlashCommand(value: string): value is ComposerSlashCommand {
  const normalizedValue = normalizeSlashCommandName(value);
  return BUILT_IN_COMPOSER_SLASH_COMMANDS.some((command) => command === normalizedValue);
}

export function filterComposerSlashCommands(
  query: string,
  commands: ReadonlyArray<ComposerSlashCommand> = BUILT_IN_COMPOSER_SLASH_COMMANDS,
): ComposerSlashCommandDefinition[] {
  const normalizedQuery = query.trim().toLowerCase();
  const matches = commands.filter((command) => {
    if (!normalizedQuery) {
      return true;
    }
    const definition = COMPOSER_SLASH_COMMAND_DEFINITIONS[command];
    return (
      command.includes(normalizedQuery) ||
      definition.label.slice(1).includes(normalizedQuery) ||
      definition.description.toLowerCase().includes(normalizedQuery)
    );
  });
  return matches.map((command) => COMPOSER_SLASH_COMMAND_DEFINITIONS[command]);
}

export interface ComposerSlashInvocation {
  command: ComposerSlashCommand;
  args: string;
}

export type FastSlashCommandAction = "toggle" | "on" | "off" | "status" | "invalid";

export function parseComposerSlashInvocationForCommands(
  text: string,
  commands: ReadonlyArray<ComposerSlashCommand>,
): ComposerSlashInvocation | null {
  const match = /^\/([a-z-]+)(?:\s+(.*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = normalizeSlashCommandName(match[1] ?? "");
  if (!command || !commands.includes(command as ComposerSlashCommand)) {
    return null;
  }
  return {
    command: command as ComposerSlashCommand,
    args: (match[2] ?? "").trim(),
  };
}

export function parseFastSlashCommandAction(text: string): FastSlashCommandAction | null {
  const invocation = parseComposerSlashInvocationForCommands(
    text,
    BUILT_IN_COMPOSER_SLASH_COMMANDS,
  );
  if (!invocation || invocation.command !== "fast") {
    return null;
  }
  const arg = invocation.args.toLowerCase();
  if (!arg) {
    return "toggle";
  }
  if (arg === "on") {
    return "on";
  }
  if (arg === "off") {
    return "off";
  }
  if (arg === "status") {
    return "status";
  }
  return "invalid";
}

export function buildSubagentsPrompt(existingPrompt: string): string {
  const cannedPrompt =
    "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results. If you fork full history/context to subagents, do not specify agent_type, model, or reasoning_effort on the spawn call; let those inherit from the parent.";
  const trimmedPrompt = existingPrompt.trim();
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${cannedPrompt}` : cannedPrompt;
}

export function buildBrowserUseComposerPrompt(
  args: string,
  options?: { projectId?: string | null | undefined },
): string {
  const trimmedArgs = args.trim();
  const browserTask =
    trimmedArgs.length > 0
      ? `Task: ${trimmedArgs}`
      : "Task: Inspect the current T3 browser tab and summarize what is visible.";
  const projectHint =
    options?.projectId && options.projectId.trim().length > 0
      ? `Use projectId \`${options.projectId}\` when setting up the browser client.`
      : "If a projectId is required, ask T3 for the active project id instead of guessing.";

  return [
    "Use T3 Browser Use for this request. If a `t3_browser` MCP server is exposed, use its `browser_*` tools directly.",
    'If `t3_browser` tools are not exposed, load the injected client with `const { pathToFileURL } = await import("node:url"); const clientUrl = pathToFileURL(process.env.T3CODE_BROWSER_USE_CLIENT_PATH).href; const { setupT3BrowserUse } = await import(clientUrl); const browser = setupT3BrowserUse({ globals: globalThis, projectId: "PROJECT_ID" });`, replacing `PROJECT_ID` with the T3 project id below.',
    "Use T3 Browser Use to open tabs, click, type, scroll, inspect snapshots, capture screenshots, and evaluate page state. With the injected client, prefer `browser.open(url)`, `browser.snapshot()`, `browser.click(selector)`, `browser.fill(selector, value)`, `browser.pressKey(key)`, and `browser.scrollBy(y)`.",
    "Do not use OpenAI Browser Use, Chrome MCP, Playwright, or an external browser unless T3 Browser Use is unavailable and I explicitly approve a fallback.",
    "Respect T3 browser settings for approvals, history access, allowed domains, blocked domains, and persisted browsing data.",
    projectHint,
    browserTask,
  ].join("\n\n");
}

export function buildSlashReviewComposerPrompt(args: string): string {
  const trimmedArgs = args.trim();
  const normalizedArgs = trimmedArgs.toLowerCase();
  const reviewTarget =
    normalizedArgs === "base" || normalizedArgs.startsWith("base ") ? "base-branch" : "changes";
  const basePrompt =
    "Review the local code changes for bugs, risks, behavioural regressions, and missing tests. Findings first, ordered by severity.";
  const targetPrompt =
    reviewTarget === "base-branch"
      ? `${basePrompt}\nFocus on the current branch diff against its base branch.`
      : `${basePrompt}\nFocus on the current uncommitted changes.`;
  if (!trimmedArgs) {
    return targetPrompt;
  }
  if (reviewTarget === "base-branch") {
    const baseBranchHint = trimmedArgs.replace(/^base\b/i, "").trim();
    return baseBranchHint.length > 0
      ? `${targetPrompt}\nUse ${baseBranchHint} as the base branch if needed.`
      : targetPrompt;
  }
  return `${targetPrompt}\nFocus especially on: ${trimmedArgs}`;
}
