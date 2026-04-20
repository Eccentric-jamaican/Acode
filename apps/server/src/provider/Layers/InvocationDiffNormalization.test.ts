import { describe, expect, it } from "vitest";

import { normalizeInvocationDiffFiles } from "./InvocationDiffNormalization.ts";

describe("normalizeInvocationDiffFiles", () => {
  it("normalizes single filediff metadata", () => {
    const files = normalizeInvocationDiffFiles({
      metadata: {
        filediff: {
          file: "apps/web/src/components/ChatView.tsx",
          additions: 3,
          deletions: 1,
          before: "a",
          after: "b",
          status: "modified",
        },
      },
    });

    expect(files).toEqual([
      {
        path: "apps/web/src/components/ChatView.tsx",
        additions: 3,
        deletions: 1,
        before: "a",
        after: "b",
        status: "modified",
      },
    ]);
  });

  it("normalizes multi-file metadata files list", () => {
    const files = normalizeInvocationDiffFiles({
      metadata: {
        files: [
          {
            relativePath: "apps/web/src/session-logic.ts",
            additions: 5,
            deletions: 2,
            patch: "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n",
          },
          {
            filePath: "apps/web/src/components/chat/MessagesTimeline.tsx",
            additions: 1,
            deletions: 4,
          },
        ],
      },
    });

    expect(files).toEqual([
      {
        path: "apps/web/src/session-logic.ts",
        additions: 5,
        deletions: 2,
        patch: "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
      },
      {
        path: "apps/web/src/components/chat/MessagesTimeline.tsx",
        additions: 1,
        deletions: 4,
      },
    ]);
  });

  it("returns empty array when no explicit diff metadata exists", () => {
    const files = normalizeInvocationDiffFiles({
      toolName: "edit",
      input: {
        filePath: "apps/web/src/components/ChatView.tsx",
      },
    });

    expect(files).toEqual([]);
  });
});

