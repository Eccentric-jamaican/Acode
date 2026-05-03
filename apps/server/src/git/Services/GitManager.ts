/**
 * GitManager - Effect service contract for stacked Git workflows.
 *
 * Orchestrates status inspection and commit/push/PR flows by composing
 * lower-level Git and external tool services.
 *
 * @module GitManager
 */
import {
  GitDiffInput,
  GitDiffResult,
  GitFilePreviewInput,
  GitFilePreviewResult,
  GitReviewActionInput,
  GitReviewActionResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { GitManagerServiceError } from "../Errors.ts";

/**
 * GitManagerShape - Service API for high-level Git workflow actions.
 */
export interface GitManagerShape {
  /**
   * Read current repository Git status plus open PR metadata when available.
   */
  readonly status: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;

  /**
   * Read a review patch for staged or unstaged repository changes.
   */
  readonly diff: (input: GitDiffInput) => Effect.Effect<GitDiffResult, GitManagerServiceError>;

  /**
   * Read before/after file bytes for visual review previews.
   */
  readonly filePreview: (
    input: GitFilePreviewInput,
  ) => Effect.Effect<GitFilePreviewResult, GitManagerServiceError>;

  /**
   * Apply a focused review action to the working tree/index.
   */
  readonly reviewAction: (
    input: GitReviewActionInput,
  ) => Effect.Effect<GitReviewActionResult, GitManagerServiceError>;

  /**
   * Run a stacked Git action (`commit`, `commit_push`, `commit_push_pr`).
   * When `featureBranch` is set, creates and checks out a feature branch first.
   */
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
}

/**
 * GitManager - Service tag for stacked Git workflow orchestration.
 */
export class GitManager extends ServiceMap.Service<GitManager, GitManagerShape>()(
  "t3/git/Services/GitManager",
) {}
