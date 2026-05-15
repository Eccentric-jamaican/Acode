import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopBrowserClient } from "./browserDesktopClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DesktopBrowserClient", () => {
  it("adds default project and thread ownership to bridge calls", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ result: { ok: true } }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new DesktopBrowserClient({
      bridgeUrl: "http://127.0.0.1:4123/rpc",
      authToken: "secret-token",
      defaultProjectId: ProjectId.makeUnsafe("project-1"),
      defaultThreadId: ThreadId.makeUnsafe("thread-1"),
    });

    await client.call("browser.show");

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestInit?.headers).toMatchObject({
      "content-type": "application/json",
      "x-t3-browser-token": "secret-token",
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      method: "browser.show",
      params: {
        projectId: "project-1",
        threadId: "thread-1",
      },
    });
  });

  it("preserves explicit thread ownership from call params", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ result: { ok: true } }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new DesktopBrowserClient({
      bridgeUrl: "http://127.0.0.1:4123/rpc",
      authToken: "secret-token",
      defaultProjectId: ProjectId.makeUnsafe("project-1"),
      defaultThreadId: ThreadId.makeUnsafe("thread-default"),
    });

    await client.call("browser.show", { threadId: "thread-explicit" });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      method: "browser.show",
      params: {
        projectId: "project-1",
        threadId: "thread-explicit",
      },
    });
  });
});
