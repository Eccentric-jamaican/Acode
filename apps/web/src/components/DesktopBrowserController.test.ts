import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  browserRouteThreadIdFromPathname,
  resolveBrowserPaneRouteTarget,
  type ResolveBrowserPaneRouteTargetInput,
} from "./DesktopBrowserController";

const projectA = ProjectId.makeUnsafe("project-a");
const projectB = ProjectId.makeUnsafe("project-b");
const threadA1 = ThreadId.makeUnsafe("thread-a-1");
const threadA2 = ThreadId.makeUnsafe("thread-a-2");
const threadB1 = ThreadId.makeUnsafe("thread-b-1");

function routeThread(input: {
  id: ThreadId;
  projectId: ProjectId;
  createdAt?: string;
  updatedAt?: string | null;
  archivedAt?: string | null;
}): ResolveBrowserPaneRouteTargetInput["threads"][number] {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    archivedAt: null,
    ...input,
  };
}

function resolveTarget(
  input: Partial<Omit<ResolveBrowserPaneRouteTargetInput, "event">> & {
    threadId?: ThreadId;
  } = {},
): ThreadId | null {
  return resolveBrowserPaneRouteTarget({
    event: {
      type: "pane.requested",
      projectId: projectA,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    pathname: input.pathname ?? "/",
    threads:
      input.threads ??
      [
        routeThread({ id: threadA1, projectId: projectA }),
        routeThread({ id: threadB1, projectId: projectB }),
      ],
    draftThreadsByThreadId: input.draftThreadsByThreadId ?? {},
    projectDraftThreadIdByProjectId: input.projectDraftThreadIdByProjectId ?? {},
  });
}

describe("DesktopBrowserController route targeting", () => {
  it("uses the requested thread when it belongs to the requested project", () => {
    expect(resolveTarget({ threadId: threadA1 })).toBe(threadA1);
  });

  it("falls back to the current route thread in the same project", () => {
    expect(resolveTarget({ threadId: ThreadId.makeUnsafe("missing"), pathname: `/${threadA1}` })).toBe(
      threadA1,
    );
  });

  it("uses the project's draft thread before older server threads", () => {
    const draftThreadId = ThreadId.makeUnsafe("draft-a");

    expect(
      resolveTarget({
        pathname: `/${threadB1}`,
        draftThreadsByThreadId: {
          [draftThreadId]: { projectId: projectA },
        },
        projectDraftThreadIdByProjectId: {
          [projectA]: draftThreadId,
        },
      }),
    ).toBe(draftThreadId);
  });

  it("falls back to the newest live project thread", () => {
    expect(
      resolveTarget({
        pathname: `/${threadB1}`,
        threads: [
          routeThread({
            id: threadA1,
            projectId: projectA,
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          routeThread({
            id: threadA2,
            projectId: projectA,
            updatedAt: "2026-02-01T00:00:00.000Z",
          }),
        ],
      }),
    ).toBe(threadA2);
  });

  it("ignores archived threads and reserved app routes", () => {
    expect(browserRouteThreadIdFromPathname("/settings")).toBeNull();
    expect(
      resolveTarget({
        pathname: "/settings",
        threads: [routeThread({ id: threadA1, projectId: projectA, archivedAt: "2026-01-01" })],
      }),
    ).toBeNull();
  });
});
