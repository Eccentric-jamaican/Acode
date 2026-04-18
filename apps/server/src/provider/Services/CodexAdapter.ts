/**
 * CodexAdapter - Codex implementation of the generic provider adapter contract.
 *
 * This service owns Codex app-server process / JSON-RPC semantics and emits
 * Codex provider events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "codex"` context.
 *
 * @module CodexAdapter
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { TurnId } from "@t3tools/contracts";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CodexStoredThreadSummary {
  readonly id: string;
  readonly preview: string | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly status: string | null;
}

export interface CodexStoredSkillSummary {
  readonly name: string;
  readonly description: string | null;
  readonly displayName: string | null;
  readonly shortDescription: string | null;
}

export interface CodexReviewTarget {
  readonly type: "uncommittedChanges";
}

export interface CodexReviewStartResult {
  readonly reviewThreadId: string;
  readonly turnId: TurnId | null;
}

/**
 * CodexAdapterShape - Service API for the Codex provider adapter.
 */
export interface CodexAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "codex";
  readonly listStoredThreads: (input: {
    readonly cwd: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<CodexStoredThreadSummary>, ProviderAdapterError>;
  readonly listStoredSkills: (input: {
    readonly cwd: string;
    readonly forceReload?: boolean;
  }) => Effect.Effect<ReadonlyArray<CodexStoredSkillSummary>, ProviderAdapterError>;
  readonly readStoredThread: (input: {
    readonly providerThreadId: string;
    readonly cwd: string;
    readonly includeTurns?: boolean;
  }) => Effect.Effect<{
    readonly threadId: string;
    readonly turns: ReadonlyArray<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  }, ProviderAdapterError>;
  readonly archiveStoredThread: (input: {
    readonly providerThreadId: string;
    readonly cwd: string;
  }) => Effect.Effect<void, ProviderAdapterError>;
  readonly startReview: (input: {
    readonly providerThreadId: string;
    readonly cwd: string;
    readonly target: CodexReviewTarget;
    readonly delivery?: "inline" | "detached";
  }) => Effect.Effect<CodexReviewStartResult, ProviderAdapterError>;
}

/**
 * CodexAdapter - Service tag for Codex provider adapter operations.
 */
export class CodexAdapter extends ServiceMap.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Services/CodexAdapter",
) {}
