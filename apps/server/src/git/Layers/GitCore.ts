import { Cache, Data, Duration, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { spawn } from "node:child_process";
import * as NodePath from "node:path";

import { GitCommandError } from "../Errors.ts";
import { GitService } from "../Services/GitService.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";

const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_FILE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  cwd: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

interface ExecuteGitOptions {
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted((a, b) => b.length - a.length);
}

function parseRemoteRefWithRemoteNames(
  branchName: string,
  remoteNames: ReadonlyArray<string>,
): { remoteRef: string; remoteName: string; localBranch: string } | null {
  const trimmedBranchName = branchName.trim();
  if (trimmedBranchName.length === 0) return null;

  for (const remoteName of remoteNames) {
    const remotePrefix = `${remoteName}/`;
    if (!trimmedBranchName.startsWith(remotePrefix)) {
      continue;
    }
    const localBranch = trimmedBranchName.slice(remotePrefix.length).trim();
    if (localBranch.length === 0) {
      return null;
    }
    return {
      remoteRef: trimmedBranchName,
      remoteName,
      localBranch,
    };
  }

  return null;
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const upstreamBranch = upstreamBranchRaw.trim();
    if (branchName.length === 0 || upstreamBranch.length === 0) {
      continue;
    }
    if (upstreamBranch === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function parseDefaultBranchFromRemoteHeadRef(value: string): string | null {
  const trimmed = value.trim();
  const prefix = "refs/remotes/origin/";
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isPathInsideWorkspace(cwd: string, relativePath: string): boolean {
  const root = NodePath.resolve(cwd);
  const target = NodePath.resolve(root, relativePath);
  const relative = NodePath.relative(root, target);
  return relative.length === 0 || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function readGitObjectBytes(input: {
  args: readonly string[];
  cwd: string;
  operation: string;
}): Effect.Effect<Buffer | null, GitCommandError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<Buffer | null>((resolve, reject) => {
        const child = spawn("git", [...input.args], {
          cwd: input.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdoutChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let settled = false;

        const settle = (value: Buffer | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          reject(cause);
        };

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > GIT_FILE_PREVIEW_MAX_BYTES) {
            child.kill();
            fail(new Error(`File preview exceeded ${GIT_FILE_PREVIEW_MAX_BYTES} bytes.`));
            return;
          }
          stdoutChunks.push(chunk);
        });
        child.stderr.resume();
        child.on("error", fail);
        child.on("close", (code) => {
          if (settled) return;
          if (code === 0) {
            settle(Buffer.concat(stdoutChunks));
            return;
          }
          settle(null);
        });
      }),
    catch: (cause) =>
      createGitCommandError(
        input.operation,
        input.cwd,
        input.args,
        "Failed to read git file.",
        cause,
      ),
  });
}

const makeGitCore = Effect.gen(function* () {
  const git = yield* GitService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
    git
      .execute({
        operation,
        cwd,
        args,
        allowNonZeroExit: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      .pipe(
        Effect.flatMap((result) => {
          if (options.allowNonZeroExit || result.code === 0) {
            return Effect.succeed(result);
          }
          const stderr = result.stderr.trim();
          if (stderr.length > 0) {
            return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
          }
          if (options.fallbackErrorMessage) {
            return Effect.fail(
              createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
            );
          }
          return Effect.fail(
            createGitCommandError(
              operation,
              cwd,
              args,
              `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
            ),
          );
        }),
      );

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const branchExists = (cwd: string, branch: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const resolveAvailableBranchName = (
    cwd: string,
    desiredBranch: string,
  ): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
      if (!isDesiredTaken) {
        return desiredBranch;
      }

      for (let suffix = 1; suffix <= 100; suffix += 1) {
        const candidate = `${desiredBranch}-${suffix}`;
        const isCandidateTaken = yield* branchExists(cwd, candidate);
        if (!isCandidateTaken) {
          return candidate;
        }
      }

      return yield* createGitCommandError(
        "GitCore.renameBranch",
        cwd,
        ["branch", "-m", "--", desiredBranch],
        `Could not find an available branch name for '${desiredBranch}'.`,
      );
    });

  const resolveCurrentUpstream = (
    cwd: string,
  ): Effect.Effect<
    { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
    GitCommandError
  > =>
    Effect.gen(function* () {
      const upstreamRef = yield* runGitStdout(
        "GitCore.resolveCurrentUpstream",
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
        return null;
      }

      const separatorIndex = upstreamRef.indexOf("/");
      if (separatorIndex <= 0) {
        return null;
      }
      const remoteName = upstreamRef.slice(0, separatorIndex);
      const upstreamBranch = upstreamRef.slice(separatorIndex + 1);
      if (remoteName.length === 0 || upstreamBranch.length === 0) {
        return null;
      }

      return {
        upstreamRef,
        remoteName,
        upstreamBranch,
      };
    });

  const fetchUpstreamRef = (
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Effect.Effect<void, GitCommandError> => {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    return runGit(
      "GitCore.fetchUpstreamRef",
      cwd,
      ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
      true,
    );
  };

  const fetchUpstreamRefForStatus = (
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Effect.Effect<void, GitCommandError> => {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    return executeGit(
      "GitCore.fetchUpstreamRefForStatus",
      cwd,
      ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
      {
        allowNonZeroExit: true,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const statusUpstreamRefreshCache = yield* Cache.makeWith({
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    lookup: (cacheKey: StatusUpstreamRefreshCacheKey) =>
      Effect.gen(function* () {
        yield* fetchUpstreamRefForStatus(cacheKey.cwd, {
          upstreamRef: cacheKey.upstreamRef,
          remoteName: cacheKey.remoteName,
          upstreamBranch: cacheKey.upstreamBranch,
        });
        return true as const;
      }),
    // Keep successful refreshes warm; drop failures immediately so next request can retry.
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_UPSTREAM_REFRESH_INTERVAL : Duration.zero),
  });

  const refreshStatusUpstreamIfStale = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      yield* Cache.get(
        statusUpstreamRefreshCache,
        new StatusUpstreamRefreshCacheKey({
          cwd,
          upstreamRef: upstream.upstreamRef,
          remoteName: upstream.remoteName,
          upstreamBranch: upstream.upstreamBranch,
        }),
      );
    });

  const refreshCheckedOutBranchUpstream = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      yield* fetchUpstreamRefForStatus(cwd, upstream);
    });

  const resolveDefaultBranchName = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitCore.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.code !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    branch: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitCore.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.code === 0));

  const resolveBaseBranchForNoUpstream = (
    cwd: string,
    branch: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      const configuredBaseBranch = yield* runGitStdout(
        "GitCore.resolveBaseBranchForNoUpstream.config",
        cwd,
        ["config", "--get", `branch.${branch}.gh-merge-base`],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const defaultBranch = yield* resolveDefaultBranchName(cwd);
      const candidates = [
        configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
        defaultBranch,
        ...DEFAULT_BASE_BRANCH_CANDIDATES,
      ];

      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }

        const normalizedCandidate = candidate.startsWith("origin/")
          ? candidate.slice("origin/".length)
          : candidate;
        if (normalizedCandidate.length === 0 || normalizedCandidate === branch) {
          continue;
        }

        if (yield* branchExists(cwd, normalizedCandidate)) {
          return normalizedCandidate;
        }

        if (yield* remoteBranchExists(cwd, normalizedCandidate)) {
          return `origin/${normalizedCandidate}`;
        }
      }

      return null;
    });

  const computeAheadCountAgainstBase = (
    cwd: string,
    branch: string,
  ): Effect.Effect<number, GitCommandError> =>
    Effect.gen(function* () {
      const baseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch);
      if (!baseBranch) {
        return 0;
      }

      const result = yield* executeGit(
        "GitCore.computeAheadCountAgainstBase",
        cwd,
        ["rev-list", "--count", `${baseBranch}..HEAD`],
        { allowNonZeroExit: true },
      );
      if (result.code !== 0) {
        return 0;
      }

      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    });

  const readBranchRecency = (cwd: string): Effect.Effect<Map<string, number>, GitCommandError> =>
    Effect.gen(function* () {
      const branchRecency = yield* executeGit(
        "GitCore.readBranchRecency",
        cwd,
        [
          "for-each-ref",
          "--format=%(refname:short)%09%(committerdate:unix)",
          "refs/heads",
          "refs/remotes",
        ],
        {
          timeoutMs: 15_000,
          allowNonZeroExit: true,
        },
      );

      const branchLastCommit = new Map<string, number>();
      if (branchRecency.code !== 0) {
        return branchLastCommit;
      }

      for (const line of branchRecency.stdout.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const [name, lastCommitRaw] = line.split("\t");
        if (!name) {
          continue;
        }
        const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
        branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
      }

      return branchLastCommit;
    });

  const statusDetails: GitCoreShape["statusDetails"] = (cwd) =>
    Effect.gen(function* () {
      yield* refreshStatusUpstreamIfStale(cwd).pipe(Effect.catch(() => Effect.void));

      let branch: string | null = null;
      let upstreamRef: string | null = null;
      let aheadCount = 0;
      let behindCount = 0;
      let hasWorkingTreeChanges = false;
      const changedFilesWithoutNumstat = new Set<string>();
      const statusStdout = yield* runGitStdout("GitCore.statusDetails.status", cwd, [
        "status",
        "--porcelain=2",
        "--branch",
      ]);

      for (const line of statusStdout.split(/\r?\n/g)) {
        if (line.startsWith("# branch.head ")) {
          const value = line.slice("# branch.head ".length).trim();
          branch = value.startsWith("(") ? null : value;
          continue;
        }
        if (line.startsWith("# branch.upstream ")) {
          const value = line.slice("# branch.upstream ".length).trim();
          upstreamRef = value.length > 0 ? value : null;
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const value = line.slice("# branch.ab ".length).trim();
          const parsed = parseBranchAb(value);
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
          continue;
        }
        if (line.trim().length > 0 && !line.startsWith("#")) {
          hasWorkingTreeChanges = true;
          const pathValue = parsePorcelainPath(line);
          if (pathValue) changedFilesWithoutNumstat.add(pathValue);
        }
      }

      if (!upstreamRef && branch) {
        aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(0)),
        );
        behindCount = 0;
      }

      if (!hasWorkingTreeChanges) {
        return {
          branch,
          upstreamRef,
          hasWorkingTreeChanges,
          workingTree: {
            files: [],
            insertions: 0,
            deletions: 0,
          },
          hasUpstream: upstreamRef !== null,
          aheadCount,
          behindCount,
        };
      }

      const [unstagedNumstatStdout, stagedNumstatStdout] = yield* Effect.all(
        [
          runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
          runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
            "diff",
            "--cached",
            "--numstat",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
      const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
      const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const entry of [...stagedEntries, ...unstagedEntries]) {
        const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        fileStatMap.set(entry.path, existing);
      }

      let insertions = 0;
      let deletions = 0;
      const files = Array.from(fileStatMap.entries())
        .map(([filePath, stat]) => {
          insertions += stat.insertions;
          deletions += stat.deletions;
          return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
        })
        .toSorted((a, b) => a.path.localeCompare(b.path));

      for (const filePath of changedFilesWithoutNumstat) {
        if (fileStatMap.has(filePath)) continue;
        files.push({ path: filePath, insertions: 0, deletions: 0 });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      return {
        branch,
        upstreamRef,
        hasWorkingTreeChanges,
        workingTree: {
          files,
          insertions,
          deletions,
        },
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
      };
    });

  const status: GitCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  const diff: GitCoreShape["diff"] = (input) =>
    Effect.gen(function* () {
      const args =
        input.scope === "staged"
          ? ["diff", "--cached", "--patch", "--no-ext-diff"]
          : input.scope === "branch"
            ? ["diff", "--patch", "--no-ext-diff", "HEAD"]
            : ["diff", "--patch", "--no-ext-diff"];
      const patch = yield* runGitStdout("GitCore.diff", input.cwd, args);
      return {
        scope: input.scope,
        patch,
      };
    });

  const filePreview: GitCoreShape["filePreview"] = (input) =>
    Effect.gen(function* () {
      if (!isPathInsideWorkspace(input.cwd, input.path)) {
        return yield* createGitCommandError(
          "GitCore.filePreview",
          input.cwd,
          ["show", input.path],
          "File preview path must stay inside the workspace.",
        );
      }

      const readRef = (ref: string, refLabel: string) =>
        readGitObjectBytes({
          cwd: input.cwd,
          operation: "GitCore.filePreview.readRef",
          args: ["show", `${ref}:${input.path}`],
        }).pipe(
          Effect.map((bytes) =>
            bytes
              ? {
                  contentsBase64: bytes.toString("base64"),
                  refLabel,
                  status: "present" as const,
                }
              : {
                  refLabel,
                  status: "missing" as const,
                },
          ),
        );

      const readWorktree = (refLabel: string) =>
        fileSystem.readFile(NodePath.resolve(input.cwd, input.path)).pipe(
          Effect.map((bytes) => ({
            contentsBase64: Buffer.from(bytes).toString("base64"),
            refLabel,
            status: "present" as const,
          })),
          Effect.catch(() =>
            Effect.succeed({
              refLabel,
              status: "missing" as const,
            }),
          ),
        );

      const branchBaseRef =
        input.scope === "branch" && input.baseRef
          ? yield* runGitStdout("GitCore.filePreview.mergeBase", input.cwd, [
              "merge-base",
              "HEAD",
              input.baseRef,
            ]).pipe(
              Effect.map((stdout) => stdout.trim()),
              Effect.catch(() => Effect.succeed(input.baseRef ?? "HEAD")),
            )
          : null;

      const before =
        input.scope === "branch"
          ? yield* readRef(branchBaseRef ?? input.baseRef ?? "HEAD", "Before")
          : yield* readRef("HEAD", "Before");
      const after =
        input.scope === "staged"
          ? yield* readRef("", "After")
          : input.scope === "branch"
            ? yield* readRef("HEAD", "After")
            : yield* readWorktree("After");

      return {
        after,
        before,
        path: input.path,
        scope: input.scope,
      };
    });

  const reviewAction: GitCoreShape["reviewAction"] = (input) =>
    Effect.gen(function* () {
      const requirePath = function (operation: string): Effect.Effect<string, GitCommandError> {
        return input.path
          ? Effect.succeed(input.path)
          : Effect.fail(
              new GitCommandError({
                operation,
                command: input.action,
                cwd: input.cwd,
                detail: "A file path is required for this review action.",
              }),
            );
      };

      switch (input.action) {
        case "stageAll": {
          yield* runGit("GitCore.reviewAction.stageAll", input.cwd, ["add", "-A"]);
          break;
        }
        case "stagePath": {
          const path = yield* requirePath("GitCore.reviewAction.stagePath");
          yield* runGit("GitCore.reviewAction.stagePath", input.cwd, ["add", "--", path]);
          break;
        }
        case "unstageAll": {
          yield* runGit("GitCore.reviewAction.unstageAll", input.cwd, [
            "restore",
            "--staged",
            "--",
            ".",
          ]);
          break;
        }
        case "unstagePath": {
          const path = yield* requirePath("GitCore.reviewAction.unstagePath");
          yield* runGit("GitCore.reviewAction.unstagePath", input.cwd, [
            "restore",
            "--staged",
            "--",
            path,
          ]);
          break;
        }
        case "revertUnstagedAll": {
          yield* runGit("GitCore.reviewAction.revertUnstagedAll", input.cwd, [
            "restore",
            "--worktree",
            "--",
            ".",
          ]);
          break;
        }
        case "revertUnstagedPath": {
          const path = yield* requirePath("GitCore.reviewAction.revertUnstagedPath");
          yield* runGit("GitCore.reviewAction.revertUnstagedPath", input.cwd, [
            "restore",
            "--worktree",
            "--",
            path,
          ]);
          break;
        }
      }

      return {
        action: input.action,
        status: "applied" as const,
      };
    });

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = (cwd) =>
    Effect.gen(function* () {
      yield* runGit("GitCore.prepareCommitContext.addAll", cwd, ["add", "-A"]);

      const stagedSummary = yield* runGitStdout("GitCore.prepareCommitContext.stagedSummary", cwd, [
        "diff",
        "--cached",
        "--name-status",
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }

      const stagedPatch = yield* runGitStdout("GitCore.prepareCommitContext.stagedPatch", cwd, [
        "diff",
        "--cached",
        "--patch",
        "--minimal",
      ]);

      return {
        stagedSummary,
        stagedPatch,
      };
    });

  const commit: GitCoreShape["commit"] = (cwd, subject, body) =>
    Effect.gen(function* () {
      const args = ["commit", "-m", subject];
      const trimmedBody = body.trim();
      if (trimmedBody.length > 0) {
        args.push("-m", trimmedBody);
      }
      yield* runGit("GitCore.commit.commit", cwd, args);
      const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
        "rev-parse",
        "HEAD",
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha };
    });

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }

      const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
      if (hasNoLocalDelta) {
        if (details.hasUpstream) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
            ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          };
        }

        const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (comparableBaseBranch) {
          const hasOriginRemote = yield* originRemoteExists(cwd).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!hasOriginRemote) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }

          const hasRemoteBranch = yield* remoteBranchExists(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
          if (hasRemoteBranch) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }
        }
      }

      if (!details.hasUpstream) {
        yield* runGit("GitCore.pushCurrentBranch.pushWithUpstream", cwd, [
          "push",
          "-u",
          "origin",
          branch,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `origin/${branch}`,
          setUpstream: true,
        };
      }

      yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"]);
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    });

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = (cwd) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      yield* executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
        timeoutMs: 30_000,
        fallbackErrorMessage: "git pull failed",
      });
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    });

  const readRangeContext: GitCoreShape["readRangeContext"] = (cwd, baseBranch) =>
    Effect.gen(function* () {
      const range = `${baseBranch}..HEAD`;
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runGitStdout("GitCore.readRangeContext.log", cwd, ["log", "--oneline", range]),
          runGitStdout("GitCore.readRangeContext.diffStat", cwd, ["diff", "--stat", range]),
          runGitStdout("GitCore.readRangeContext.diffPatch", cwd, [
            "diff",
            "--patch",
            "--minimal",
            range,
          ]),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    });

  const readBranchReviewPatch: GitCoreShape["readBranchReviewPatch"] = (cwd, baseBranch) =>
    Effect.gen(function* () {
      const mergeBase = yield* runGitStdout("GitCore.readBranchReviewPatch.mergeBase", cwd, [
        "merge-base",
        "HEAD",
        baseBranch,
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      const baseRef = mergeBase.length > 0 ? mergeBase : baseBranch;
      return yield* runGitStdout("GitCore.readBranchReviewPatch.diff", cwd, [
        "diff",
        "--patch",
        "--minimal",
        "--no-ext-diff",
        baseRef,
      ]);
    });

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const cloneRepo: GitCoreShape["cloneRepo"] = (input) =>
    Effect.gen(function* () {
      const sanitizedDirectoryName = input.directoryName.trim();
      if (
        sanitizedDirectoryName.length === 0 ||
        sanitizedDirectoryName === "." ||
        sanitizedDirectoryName === ".." ||
        sanitizedDirectoryName.includes("/") ||
        sanitizedDirectoryName.includes("\\")
      ) {
        return yield* createGitCommandError(
          "GitCore.cloneRepo",
          input.parentDirectory,
          ["clone", input.repositoryUrl, input.directoryName],
          "Repository folder name must be a single directory name.",
        );
      }

      const destinationPath = path.join(input.parentDirectory, sanitizedDirectoryName);
      const existingDestination = yield* fileSystem.stat(destinationPath).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (existingDestination) {
        return yield* createGitCommandError(
          "GitCore.cloneRepo",
          input.parentDirectory,
          ["clone", input.repositoryUrl, sanitizedDirectoryName],
          `Destination already exists: ${destinationPath}`,
        );
      }

      yield* fileSystem
        .makeDirectory(input.parentDirectory, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            createGitCommandError(
              "GitCore.cloneRepo",
              input.parentDirectory,
              ["clone", input.repositoryUrl, sanitizedDirectoryName],
              `Failed to prepare destination directory: ${String(cause)}`,
              cause,
            ),
          ),
        );

      yield* executeGit(
        "GitCore.cloneRepo",
        input.parentDirectory,
        ["clone", input.repositoryUrl, sanitizedDirectoryName],
        {
          timeoutMs: 10 * 60_000,
          fallbackErrorMessage: "git clone failed",
        },
      );

      return {
        cwd: destinationPath,
        repositoryUrl: input.repositoryUrl,
        directoryName: sanitizedDirectoryName,
      };
    });

  const listBranches: GitCoreShape["listBranches"] = (input) =>
    Effect.gen(function* () {
      const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, number>())),
      );
      const localBranchResult = yield* executeGit(
        "GitCore.listBranches.branchNoColor",
        input.cwd,
        ["branch", "--no-color"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      );

      if (localBranchResult.code !== 0) {
        const stderr = localBranchResult.stderr.trim();
        if (stderr.toLowerCase().includes("not a git repository")) {
          return { branches: [], isRepo: false };
        }
        return yield* createGitCommandError(
          "GitCore.listBranches",
          input.cwd,
          ["branch", "--no-color"],
          stderr || "git branch failed",
        );
      }

      const remoteBranchResultEffect = executeGit(
        "GitCore.listBranches.remoteBranches",
        input.cwd,
        ["branch", "--no-color", "--remotes"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
          ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
        ),
      );

      const remoteNamesResultEffect = executeGit(
        "GitCore.listBranches.remoteNames",
        input.cwd,
        ["remote"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
          ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
        ),
      );

      const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
        yield* Effect.all(
          [
            executeGit(
              "GitCore.listBranches.defaultRef",
              input.cwd,
              ["symbolic-ref", "refs/remotes/origin/HEAD"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            executeGit(
              "GitCore.listBranches.worktreeList",
              input.cwd,
              ["worktree", "list", "--porcelain"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            remoteBranchResultEffect,
            remoteNamesResultEffect,
            branchRecencyPromise,
          ],
          { concurrency: "unbounded" },
        );

      const remoteNames =
        remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
      if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
        );
      }
      if (remoteNamesResult.code !== 0 && remoteNamesResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitCore.listBranches: remote name lookup returned code ${remoteNamesResult.code} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
        );
      }

      const defaultBranch =
        defaultRef.code === 0
          ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      const worktreeMap = new Map<string, string>();
      if (worktreeList.code === 0) {
        let currentPath: string | null = null;
        for (const line of worktreeList.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            const candidatePath = line.slice("worktree ".length);
            const exists = yield* fileSystem.stat(candidatePath).pipe(
              Effect.map(() => true),
              Effect.catch(() => Effect.succeed(false)),
            );
            currentPath = exists ? candidatePath : null;
          } else if (line.startsWith("branch refs/heads/") && currentPath) {
            worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
          } else if (line === "") {
            currentPath = null;
          }
        }
      }

      const localBranches = localBranchResult.stdout
        .split("\n")
        .map(parseBranchLine)
        .filter((branch): branch is { name: string; current: boolean } => branch !== null)
        .map((branch) => ({
          name: branch.name,
          current: branch.current,
          isRemote: false,
          isDefault: branch.name === defaultBranch,
          worktreePath: worktreeMap.get(branch.name) ?? null,
        }))
        .toSorted((a, b) => {
          const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
          const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
          if (aPriority !== bPriority) return aPriority - bPriority;

          const aLastCommit = branchLastCommit.get(a.name) ?? 0;
          const bLastCommit = branchLastCommit.get(b.name) ?? 0;
          if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
          return a.name.localeCompare(b.name);
        });

      const remoteBranches =
        remoteBranchResult.code === 0
          ? remoteBranchResult.stdout
              .split("\n")
              .map(parseBranchLine)
              .filter((branch): branch is { name: string; current: boolean } => branch !== null)
              .map((branch) => {
                const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
                const remoteBranch: {
                  name: string;
                  current: boolean;
                  isRemote: boolean;
                  remoteName?: string;
                  isDefault: boolean;
                  worktreePath: string | null;
                } = {
                  name: branch.name,
                  current: false,
                  isRemote: true,
                  isDefault: false,
                  worktreePath: null,
                };
                if (parsedRemoteRef) {
                  remoteBranch.remoteName = parsedRemoteRef.remoteName;
                }
                return remoteBranch;
              })
              .toSorted((a, b) => {
                const aLastCommit = branchLastCommit.get(a.name) ?? 0;
                const bLastCommit = branchLastCommit.get(b.name) ?? 0;
                if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
                return a.name.localeCompare(b.name);
              })
          : [];

      const branches = [...localBranches, ...remoteBranches];

      return { branches, isRepo: true };
    });

  const createWorktree: GitCoreShape["createWorktree"] = (input) =>
    Effect.gen(function* () {
      const sanitizedBranch = input.newBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      const worktreePath =
        input.path ?? path.join(homeDir, ".t3", "worktrees", repoName, sanitizedBranch);

      yield* executeGit(
        "GitCore.createWorktree",
        input.cwd,
        ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch],
        {
          fallbackErrorMessage: "git worktree add failed",
        },
      );

      return {
        worktree: {
          path: worktreePath,
          branch: input.newBranch,
        },
      };
    });

  const removeWorktree: GitCoreShape["removeWorktree"] = (input) =>
    Effect.gen(function* () {
      const args = ["worktree", "remove"];
      if (input.force) {
        args.push("--force");
      }
      args.push(input.path);
      yield* executeGit("GitCore.removeWorktree", input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      }).pipe(
        Effect.mapError((error) =>
          createGitCommandError(
            "GitCore.removeWorktree",
            input.cwd,
            args,
            `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
        ),
      );
    });

  const renameBranch: GitCoreShape["renameBranch"] = (input) =>
    Effect.gen(function* () {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitCore.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    });

  const createBranch: GitCoreShape["createBranch"] = (input) =>
    executeGit("GitCore.createBranch", input.cwd, ["branch", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    }).pipe(Effect.asVoid);

  const checkoutBranch: GitCoreShape["checkoutBranch"] = (input) =>
    Effect.gen(function* () {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitCore.checkoutBranch.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
          executeGit(
            "GitCore.checkoutBranch.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitCore.checkoutBranch.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.code === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.branch]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.branch]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.branch];

      yield* executeGit("GitCore.checkoutBranch.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      yield* refreshCheckedOutBranchUpstream(input.cwd).pipe(Effect.catch(() => Effect.void));
    });

  const initRepo: GitCoreShape["initRepo"] = (input) =>
    executeGit("GitCore.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitCore.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  return {
    status,
    statusDetails,
    diff,
    filePreview,
    reviewAction,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readBranchReviewPatch,
    readConfigValue,
    cloneRepo,
    listBranches,
    createWorktree,
    removeWorktree,
    renameBranch,
    createBranch,
    checkoutBranch,
    initRepo,
    listLocalBranchNames,
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore);
