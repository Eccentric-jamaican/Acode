import type { ProviderKind } from "@t3tools/contracts";

import { ClaudeAI, OpenAI, OpenCodeIcon, type Icon } from "./Icons";
import { cn } from "../lib/utils";

const PROVIDER_LOGOS: Record<ProviderKind, Icon> = {
  codex: OpenAI,
  opencode: OpenCodeIcon,
  claudeAgent: ClaudeAI,
};

const PROVIDER_LOGO_ALT: Record<ProviderKind, string> = {
  codex: "Codex logo",
  opencode: "OpenCode logo",
  claudeAgent: "Claude Code logo",
};

interface ProviderLogoProps {
  provider: ProviderKind;
  className?: string;
  alt?: string;
}

export function ProviderLogo({ provider, className, alt }: ProviderLogoProps) {
  const Logo = PROVIDER_LOGOS[provider];
  return (
    <Logo
      role="img"
      aria-label={alt ?? PROVIDER_LOGO_ALT[provider]}
      className={cn("size-4 shrink-0", className)}
    />
  );
}
