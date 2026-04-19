import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  humanizeSubagentStatus,
  resolveSubagentPresentation,
  resolveSubagentPresentationForThread,
} from "./subagentPresentation";

describe("subagentPresentation", () => {
  it("prefers nickname and role when available", () => {
    const presentation = resolveSubagentPresentation({
      nickname: "Locke",
      role: "explorer",
      title: "Subagent child-provider-1",
      fallbackId: "subagent:thread-1:child-provider-1",
    });

    expect(presentation.primaryLabel).toBe("Locke");
    expect(presentation.fullLabel).toBe("Locke [explorer]");
  });

  it("falls back to a readable thread id when title is generic", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent",
      fallbackId: "subagent:thread-1:child-provider-2",
    });

    expect(presentation.primaryLabel).toBe("child-provider-2");
  });

  it("uses the first assistant update when a child thread only has a generic title", () => {
    const presentation = resolveSubagentPresentationForThread({
      thread: {
        id: ThreadId.makeUnsafe("subagent:thread-1:child-provider-3"),
        title: "Subagent child-provider-3",
        model: "gpt-5.4",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        messages: [
          {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Tracing the runtime handoff path and mapping the server entrypoints that own session state.",
            createdAt: "2026-03-01T00:00:00.000Z",
            streaming: false,
            completedAt: "2026-03-01T00:00:00.000Z",
          },
        ],
        activities: [],
      },
    });

    expect(presentation.primaryLabel).toBe("Tracing the runtime handoff path and mapping the server entrypoints...");
  });

  it("humanizes status with active override", () => {
    expect(humanizeSubagentStatus("completed", false)).toBe("Completed");
    expect(humanizeSubagentStatus("failed", false)).toBe("Failed");
    expect(humanizeSubagentStatus("queued", false)).toBe("Queued");
    expect(humanizeSubagentStatus("completed", true)).toBe("Running");
  });
});
