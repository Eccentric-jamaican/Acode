import { describe, expect, it, vi } from "vitest";

import { OpencodeMessageRoleGate } from "./OpencodeMessageRoleGate.ts";

describe("OpencodeMessageRoleGate", () => {
  it("prefers normalized role hints and skips fetch", async () => {
    const gate = new OpencodeMessageRoleGate();
    const fetchRole = vi.fn(async () => "user");

    const resolved = await gate.resolve({
      sessionId: "ses-1",
      messageId: "msg-1",
      roleHint: " Assistant ",
      fetchRole,
    });

    expect(resolved).toBe("assistant");
    expect(fetchRole).not.toHaveBeenCalled();
  });

  it("caches fetched roles by session/message", async () => {
    const gate = new OpencodeMessageRoleGate();
    const fetchRole = vi.fn(async () => "assistant");

    const first = await gate.resolve({
      sessionId: "ses-1",
      messageId: "msg-1",
      fetchRole,
    });
    const second = await gate.resolve({
      sessionId: "ses-1",
      messageId: "msg-1",
      fetchRole,
    });

    expect(first).toBe("assistant");
    expect(second).toBe("assistant");
    expect(fetchRole).toHaveBeenCalledTimes(1);
  });

  it("clears one session without affecting others", async () => {
    const gate = new OpencodeMessageRoleGate();
    const fetchSes1 = vi.fn(async () => "assistant");
    const fetchSes2 = vi.fn(async () => "assistant");

    await gate.resolve({
      sessionId: "ses-1",
      messageId: "msg-1",
      fetchRole: fetchSes1,
    });
    await gate.resolve({
      sessionId: "ses-2",
      messageId: "msg-1",
      fetchRole: fetchSes2,
    });

    gate.clearSession("ses-1");

    await gate.resolve({
      sessionId: "ses-1",
      messageId: "msg-1",
      fetchRole: fetchSes1,
    });
    await gate.resolve({
      sessionId: "ses-2",
      messageId: "msg-1",
      fetchRole: fetchSes2,
    });

    expect(fetchSes1).toHaveBeenCalledTimes(2);
    expect(fetchSes2).toHaveBeenCalledTimes(1);
  });
});
