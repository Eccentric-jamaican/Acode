import {
  buildSubagentIdentityDirectory,
  collectSubagentProviderThreadIds,
  extractSubagentIdentityHints,
  resolveSubagentIdentityFromDirectory,
} from "@t3tools/shared/subagents";

import type { WorkLogEntry } from "../session-logic";
import type { Thread } from "../types";
import {
  deriveSubagentLatestUpdate,
  deriveSubagentThreadStatus,
  localSubagentThreadId,
  resolveSubagentPresentationForThread,
} from "./subagentPresentation";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function findMatchingSubagentThread(input: {
  parentThreadId: string | null;
  providerThreadId: string;
  agentId?: string | undefined;
  threads: ReadonlyArray<Thread>;
}): Thread | undefined {
  if (input.parentThreadId) {
    const derivedId = localSubagentThreadId(input.parentThreadId, input.providerThreadId);
    const directMatch = input.threads.find((thread) => thread.id === derivedId);
    if (directMatch) {
      return directMatch;
    }
  }

  if (input.parentThreadId && input.agentId) {
    const parentScopedAgentMatch = input.threads.find(
      (thread) =>
        thread.parentThreadId === input.parentThreadId && thread.subagentAgentId === input.agentId,
    );
    if (parentScopedAgentMatch) {
      return parentScopedAgentMatch;
    }
  }

  if (input.agentId) {
    return input.threads.find((thread) => thread.subagentAgentId === input.agentId);
  }

  return undefined;
}

function extractSubagentSourceRecords(entry: WorkLogEntry): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pushRecord = (value: unknown) => {
    const record = asRecord(value);
    if (!record) {
      return;
    }
    records.push(record);
  };

  pushRecord(entry.payload);
  const payloadRecord = asRecord(entry.payload);
  pushRecord(payloadRecord?.data);
  pushRecord(asRecord(payloadRecord?.data)?.item);

  return records;
}

export function enrichSubagentWorkEntries(input: {
  entries: ReadonlyArray<WorkLogEntry>;
  parentThreadId: string | null;
  threads: ReadonlyArray<Thread>;
}): WorkLogEntry[] {
  return input.entries.map((entry) => {
    if (entry.itemType !== "collab_agent_tool_call") {
      return entry;
    }

    const identitiesByProviderThreadId = new Map<
      string,
      ReturnType<typeof resolveSubagentIdentityFromDirectory>
    >();

    for (const record of extractSubagentSourceRecords(entry)) {
      const hints = extractSubagentIdentityHints(record);
      const directory = buildSubagentIdentityDirectory(hints);
      for (const providerThreadId of collectSubagentProviderThreadIds(record)) {
        identitiesByProviderThreadId.set(
          providerThreadId,
          resolveSubagentIdentityFromDirectory(directory, { providerThreadId }),
        );
      }
    }

    const subagents = [...identitiesByProviderThreadId.entries()]
      .flatMap(([providerThreadId, identity]) => {
        if (!identity) {
          return [];
        }
        const matchedThread = findMatchingSubagentThread({
          parentThreadId: input.parentThreadId,
          providerThreadId,
          agentId: identity.agentId,
          threads: input.threads,
        });
        const status = deriveSubagentThreadStatus(matchedThread);
        const presentation = matchedThread
          ? resolveSubagentPresentationForThread({ thread: matchedThread })
          : null;
        const resolvedNickname = identity.nickname ?? presentation?.nickname;
        const resolvedRole = identity.role ?? presentation?.role;
        const resolvedModel = identity.model ?? matchedThread?.model;
        const latestUpdate = deriveSubagentLatestUpdate(matchedThread);
        return [
          {
            threadId: providerThreadId,
            ...(matchedThread ? { resolvedThreadId: matchedThread.id } : {}),
            ...(identity.agentId ? { agentId: identity.agentId } : {}),
            ...(resolvedNickname ? { nickname: resolvedNickname } : {}),
            ...(resolvedRole ? { role: resolvedRole } : {}),
            ...(presentation?.title
              ? { title: presentation.title }
              : matchedThread?.title
                ? { title: matchedThread.title }
                : presentation?.primaryLabel
                  ? { title: presentation.primaryLabel }
                  : {}),
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(status.rawStatus ? { rawStatus: status.rawStatus } : {}),
            ...(status.statusLabel ? { statusLabel: status.statusLabel } : {}),
            ...(latestUpdate ? { latestUpdate } : {}),
            ...(status.isActive ? { isActive: true } : {}),
          },
        ];
      })
      .toSorted((left, right) =>
        (left.nickname ?? left.threadId).localeCompare(right.nickname ?? right.threadId),
      );

    if (subagents.length === 0) {
      return entry;
    }

    const firstSubagent = subagents[0];
    if (!firstSubagent) {
      return entry;
    }
    const payloadRecord = asRecord(entry.payload);
    const dataRecord = asRecord(payloadRecord?.data);
    const prompt =
      firstNonEmptyString(dataRecord?.prompt) ??
      firstNonEmptyString(payloadRecord?.detail) ??
      undefined;
    const model =
      firstNonEmptyString(dataRecord?.model) ??
      firstNonEmptyString(dataRecord?.requestedModel) ??
      firstSubagent?.model ??
      undefined;

    return {
      ...entry,
      subagentAction: {
        summaryText:
          subagents.length === 1
            ? `${firstSubagent.nickname ?? firstSubagent.title ?? "Subagent"}`
            : `${subagents.length} subagents`,
        ...(model ? { model } : {}),
        ...(prompt ? { prompt } : {}),
      },
      subagents,
    };
  });
}
