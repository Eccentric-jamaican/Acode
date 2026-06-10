import { useEffect, useMemo, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderUpdateInfo,
} from "@t3tools/contracts";
import {
  CircleArrowUpIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { toastManager } from "./ui/toast";
import { copyTextToClipboard } from "../lib/clipboard";
import { ensureNativeApi } from "../nativeApi";
import { onServerProviderUpdateStatus } from "../wsNativeApi";
import { cn } from "../lib/utils";

type CommandId = "npm" | "pnpm" | "brew";

interface ProviderUpdateButtonProps {
  readonly provider: ProviderKind;
  readonly currentVersion: string | null;
  readonly updateInfo: ServerProviderUpdateInfo | null | undefined;
}

function pickInitialCommandId(commands: ReadonlyArray<{ id: string }>): CommandId {
  if (commands.some((command) => command.id === "npm")) return "npm";
  if (commands.some((command) => command.id === "pnpm")) return "pnpm";
  return "brew";
}

function formatVersion(value: string | null | undefined): string {
  if (!value) return "—";
  return value.startsWith("v") ? value : `v${value}`;
}

function formatVersionSummary(
  currentVersion: string | null | undefined,
  latestVersion: string | null | undefined,
): string {
  if (currentVersion && latestVersion && currentVersion !== latestVersion) {
    return `${formatVersion(currentVersion)} -> ${formatVersion(latestVersion)}`;
  }
  if (currentVersion) return `Installed ${formatVersion(currentVersion)}`;
  if (latestVersion) return `Latest ${formatVersion(latestVersion)}`;
  return "—";
}

export function ProviderUpdateButton({
  provider,
  currentVersion,
  updateInfo,
}: ProviderUpdateButtonProps) {
  const [open, setOpen] = useState(false);
  const [commandId, setCommandId] = useState<CommandId | null>(null);
  const [copied, setCopied] = useState(false);
  const [launchingUpdate, setLaunchingUpdate] = useState(false);

  const commands = updateInfo?.commands ?? [];
  const activeCommandId = commandId ?? pickInitialCommandId(commands);
  const activeCommand =
    commands.find((command) => command.id === activeCommandId) ?? commands[0];
  const hasUpdate = updateInfo?.updateAvailable === true;
  const isTrusted = updateInfo?.verification.trusted === true;
  const latestVersion = updateInfo?.latestVersion ?? null;
  const errorMessage = updateInfo?.error;

  useEffect(() => {
    if (!open) {
      setCopied(false);
    }
  }, [open]);

  useEffect(
    () =>
      onServerProviderUpdateStatus((payload) => {
        if (payload.provider !== provider) return;
        if (payload.status === "started") {
          setLaunchingUpdate(true);
          return;
        }

        setLaunchingUpdate(false);
        if (payload.status === "finished") {
          toastManager.add({
            type: "success",
            title: `${PROVIDER_DISPLAY_NAMES[provider]} updated`,
            description: payload.command,
          });
          return;
        }

        toastManager.add({
          type: "error",
          title: `${PROVIDER_DISPLAY_NAMES[provider]} update failed`,
          description: payload.message ?? payload.command,
        });
      }),
    [provider],
  );

  const onCopy = async () => {
    if (!activeCommand) return;
    const ok = await copyTextToClipboard(activeCommand.command);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const onRunUpdate = async () => {
    if (!hasUpdate || !activeCommand || launchingUpdate) return;
    setLaunchingUpdate(true);
    try {
      await ensureNativeApi().server.updateProvider({
        provider,
        commandId: activeCommand.id as CommandId,
      });
      setOpen(false);
    } catch (error) {
      setLaunchingUpdate(false);
      toastManager.add({
        type: "error",
        title: `Failed to start ${PROVIDER_DISPLAY_NAMES[provider]} update`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  const triggerLabel = useMemo(() => {
    if (launchingUpdate) return `Updating ${PROVIDER_DISPLAY_NAMES[provider]}...`;
    if (errorMessage) return "Update check failed";
    if (hasUpdate) return `Update available · ${formatVersion(latestVersion)}`;
    if (latestVersion) return `Up to date · ${formatVersion(latestVersion)}`;
    return "Check for updates";
  }, [errorMessage, hasUpdate, latestVersion, launchingUpdate, provider]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        closeDelay={120}
        render={
          <button
            type="button"
            aria-label={`Check for ${PROVIDER_DISPLAY_NAMES[provider]} updates`}
            disabled={launchingUpdate}
            onClick={(event) => {
              if (!hasUpdate) return;
              event.preventDefault();
              event.stopPropagation();
              void onRunUpdate();
            }}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70",
              (hasUpdate || launchingUpdate) && "text-blue-500 hover:text-blue-600",
              errorMessage && !hasUpdate && "text-amber-500 hover:text-amber-600",
            )}
            title={triggerLabel}
          />
        }
      >
        <CircleArrowUpIcon
          className={cn(
            "size-4 text-muted-foreground transition-colors",
            launchingUpdate && "animate-spin text-blue-500",
            hasUpdate && !launchingUpdate && "text-blue-500",
            errorMessage && !hasUpdate && "text-amber-500",
          )}
        />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-80 p-0"
      >
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {PROVIDER_DISPLAY_NAMES[provider]}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {updateInfo?.packageName ?? "—"}
              </p>
            </div>
            {isTrusted ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-600">
                <ShieldCheckIcon className="size-3" />
                Verified
              </span>
            ) : null}
          </div>

          <div className="flex min-h-7 items-center rounded-md border border-border bg-muted/30 px-2 text-[11px] leading-none">
            <span className="font-medium text-foreground leading-none">
              {formatVersionSummary(currentVersion, latestVersion)}
            </span>
          </div>

          {errorMessage ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              {errorMessage}
            </p>
          ) : null}

          {commands.length > 0 ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 p-0.5">
                {commands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    onClick={() => setCommandId(command.id as CommandId)}
                    className={cn(
                      "flex-1 rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
                      activeCommandId === command.id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {command.label}
                  </button>
                ))}
              </div>
              <div className="flex items-stretch overflow-hidden rounded-md border border-border">
                <code className="flex-1 truncate bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-foreground">
                  {activeCommand?.command}
                </code>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={onCopy}
                  className="rounded-none border-l border-border px-2"
                  aria-label="Copy update command"
                  title={copied ? "Copied" : "Copy command"}
                >
                  {copied ? (
                    <CheckIcon className="size-3 text-green-500" />
                  ) : (
                    <CopyIcon className="size-3" />
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {updateInfo?.repositoryUrl ? (
            <a
              href={updateInfo.repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              View release notes
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
