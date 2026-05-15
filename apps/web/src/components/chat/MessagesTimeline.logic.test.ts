import { describe, expect, it } from "vitest";

import {
  collectComputerUseCaptures,
  computeMessageDurationStart,
  normalizeCompactToolLabel,
} from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        createdAt: "2026-03-04T12:00:02.000Z",
      },
    ];

    expect(computeMessageDurationStart(messages)).toEqual(
      new Map([["assistant-1", "2026-03-04T12:00:02.000Z"]]),
    );
  });

  it("uses the latest user message as the duration boundary", () => {
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        createdAt: "2026-03-04T12:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant" as const,
        createdAt: "2026-03-04T12:00:02.000Z",
      },
      {
        id: "assistant-2",
        role: "assistant" as const,
        createdAt: "2026-03-04T12:00:03.000Z",
      },
    ];

    expect(computeMessageDurationStart(messages)).toEqual(
      new Map([
        ["user-1", "2026-03-04T12:00:00.000Z"],
        ["assistant-1", "2026-03-04T12:00:00.000Z"],
        ["assistant-2", "2026-03-04T12:00:00.000Z"],
      ]),
    );
  });

  it("updates the next boundary from assistant completion timestamps", () => {
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        createdAt: "2026-03-04T12:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant" as const,
        createdAt: "2026-03-04T12:00:01.000Z",
        completedAt: "2026-03-04T12:00:05.000Z",
      },
      {
        id: "assistant-2",
        role: "assistant" as const,
        createdAt: "2026-03-04T12:00:06.000Z",
      },
      {
        id: "user-2",
        role: "user" as const,
        createdAt: "2026-03-04T12:00:10.000Z",
      },
      {
        id: "assistant-3",
        role: "assistant" as const,
        createdAt: "2026-03-04T12:00:11.000Z",
      },
    ];

    expect(computeMessageDurationStart(messages)).toEqual(
      new Map([
        ["user-1", "2026-03-04T12:00:00.000Z"],
        ["assistant-1", "2026-03-04T12:00:00.000Z"],
        ["assistant-2", "2026-03-04T12:00:05.000Z"],
        ["user-2", "2026-03-04T12:00:10.000Z"],
        ["assistant-3", "2026-03-04T12:00:10.000Z"],
      ]),
    );
  });

  it("returns an empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });

  it("leaves labels without completion wording unchanged", () => {
    expect(normalizeCompactToolLabel("Web search")).toBe("Web search");
  });
});

describe("collectComputerUseCaptures", () => {
  it("finds persisted computer-use captures inside structured content", () => {
    const payload = {
      data: {
        structuredContent: {
          providerNeutralType: "computer_use",
          captures: [
            {
              captureId: "capture-1",
              url: "/attachments/computer-use/thread-1/captures/capture-1.png",
              width: 625,
              height: 875,
            },
          ],
        },
      },
    };

    expect(collectComputerUseCaptures(payload)).toEqual([
      {
        captureId: "capture-1",
        url: "/attachments/computer-use/thread-1/captures/capture-1.png",
        width: 625,
        height: 875,
      },
    ]);
  });

  it("ignores non-attachment URLs so broken placeholder images are not synthesized", () => {
    expect(
      collectComputerUseCaptures({
        captures: [{ captureId: "remote", url: "https://example.test/capture.png" }],
      }),
    ).toEqual([]);
  });
});
