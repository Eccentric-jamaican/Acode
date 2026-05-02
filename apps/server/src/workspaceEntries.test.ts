import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, assert, describe, it, vi } from "vitest";

import {
  createWorkspaceDirectory,
  deleteWorkspaceEntry,
  listWorkspaceTree,
  recordWorkspaceFileWrite,
  renameWorkspaceEntry,
  searchWorkspaceEntries,
} from "./workspaceEntries";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(cwd: string, relativePath: string, contents = ""): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

describe("searchWorkspaceEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns files and directories relative to cwd", async () => {
    const cwd = makeTempDir("t3code-workspace-entries-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/index.ts");
    writeFile(cwd, "README.md");
    writeFile(cwd, ".git/HEAD");
    writeFile(cwd, "node_modules/pkg/index.js");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
    assert.include(paths, "README.md");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".git")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("node_modules")));
    assert.isFalse(result.truncated);
  });

  it("lists the cached workspace tree without a search limit", async () => {
    const cwd = makeTempDir("t3code-workspace-tree-");
    writeFile(cwd, "apps/web/src/App.tsx");
    writeFile(cwd, "packages/contracts/src/project.ts");

    const result = await listWorkspaceTree({ cwd });
    const paths = result.entries.map((entry) => entry.path);

    assert.includeMembers(paths, [
      "apps",
      "apps/web",
      "apps/web/src",
      "apps/web/src/App.tsx",
      "packages",
      "packages/contracts",
      "packages/contracts/src",
      "packages/contracts/src/project.ts",
    ]);
    assert.isFalse(result.truncated);
  });

  it("creates, renames, and deletes workspace entries", async () => {
    const cwd = makeTempDir("t3code-workspace-mutations-");

    const created = await createWorkspaceDirectory({
      cwd,
      relativePath: "src/components",
    });
    assert.equal(created.relativePath, "src/components");
    assert.isTrue(fs.statSync(path.join(cwd, "src/components")).isDirectory());

    writeFile(cwd, "src/components/Button.tsx", "export {};");

    const renamed = await renameWorkspaceEntry({
      cwd,
      fromRelativePath: "src/components/Button.tsx",
      toRelativePath: "src/components/IconButton.tsx",
    });
    assert.equal(renamed.toRelativePath, "src/components/IconButton.tsx");
    assert.isFalse(fs.existsSync(path.join(cwd, "src/components/Button.tsx")));
    assert.isTrue(fs.existsSync(path.join(cwd, "src/components/IconButton.tsx")));

    const deleted = await deleteWorkspaceEntry({
      cwd,
      relativePath: "src",
    });
    assert.equal(deleted.relativePath, "src");
    assert.isFalse(fs.existsSync(path.join(cwd, "src")));
  });

  it("patches the cached workspace tree after mutations without rescanning", async () => {
    const cwd = makeTempDir("t3code-workspace-incremental-mutations-");
    writeFile(cwd, "src/original.ts", "export {};");

    await listWorkspaceTree({ cwd });

    vi.spyOn(fsPromises, "readdir").mockRejectedValue(new Error("unexpected rescan"));

    writeFile(cwd, "src/written.ts", "export {};");
    recordWorkspaceFileWrite(cwd, "src/written.ts");
    await createWorkspaceDirectory({ cwd, relativePath: "src/components" });
    await renameWorkspaceEntry({
      cwd,
      fromRelativePath: "src/original.ts",
      toRelativePath: "src/renamed.ts",
    });
    await deleteWorkspaceEntry({ cwd, relativePath: "src/components" });

    const result = await listWorkspaceTree({ cwd });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/written.ts");
    assert.include(paths, "src/renamed.ts");
    assert.notInclude(paths, "src/original.ts");
    assert.notInclude(paths, "src/components");
  });

  it("filters and ranks entries by query", async () => {
    const cwd = makeTempDir("t3code-workspace-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

    assert.isAbove(result.entries.length, 0);
    assert.isTrue(result.entries.some((entry) => entry.path === "src/components"));
    assert.isTrue(result.entries.every((entry) => entry.path.toLowerCase().includes("compo")));
  });

  it("excludes gitignored paths for git repositories", async () => {
    const cwd = makeTempDir("t3code-workspace-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
    writeFile(cwd, "src/keep.ts", "export {};");
    writeFile(cwd, "ignored.txt", "ignore me");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.notInclude(paths, "ignored.txt");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("convex/")));
  });

  it("excludes tracked paths that match ignore rules", async () => {
    const cwd = makeTempDir("t3code-workspace-tracked-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");
    runGit(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
    writeFile(cwd, ".gitignore", ".convex/\n");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("excludes .convex in non-git workspaces", async () => {
    const cwd = makeTempDir("t3code-workspace-non-git-convex-");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("deduplicates concurrent index builds for the same cwd", async () => {
    const cwd = makeTempDir("t3code-workspace-concurrent-build-");
    writeFile(cwd, "src/components/Composer.tsx");

    let rootReadCount = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === cwd) {
        rootReadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await Promise.all([
      searchWorkspaceEntries({ cwd, query: "", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "comp", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "src", limit: 100 }),
    ]);

    assert.equal(rootReadCount, 1);
  });

  it("limits concurrent directory reads while walking the filesystem", async () => {
    const cwd = makeTempDir("t3code-workspace-read-concurrency-");
    for (let index = 0; index < 80; index += 1) {
      writeFile(cwd, `group-${index}/entry-${index}.ts`, "export {};");
    }

    let activeReads = 0;
    let peakReads = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      const target = args[0];
      if (typeof target === "string" && target.startsWith(cwd)) {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 4));
        try {
          return await originalReaddir(...args);
        } finally {
          activeReads -= 1;
        }
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await searchWorkspaceEntries({ cwd, query: "", limit: 200 });

    assert.isAtMost(peakReads, 32);
  });
});
