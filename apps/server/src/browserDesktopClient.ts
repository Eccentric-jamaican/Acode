import type { ProjectId, ThreadId } from "@t3tools/contracts";

export interface DesktopBrowserClientOptions {
  bridgeUrl: string;
  authToken: string;
  defaultProjectId?: ProjectId | undefined;
  defaultThreadId?: ThreadId | undefined;
}

export class DesktopBrowserClient {
  private readonly bridgeUrl: string;
  private readonly authToken: string;
  private readonly defaultProjectId: ProjectId | undefined;
  private readonly defaultThreadId: ThreadId | undefined;

  constructor(options: DesktopBrowserClientOptions) {
    this.bridgeUrl = options.bridgeUrl;
    this.authToken = options.authToken;
    this.defaultProjectId = options.defaultProjectId;
    this.defaultThreadId = options.defaultThreadId;
  }

  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const projectId =
      typeof params?.projectId === "string" && params.projectId.length > 0
        ? (params.projectId as ProjectId)
        : this.defaultProjectId;
    const payloadWithProject =
      projectId && (params?.projectId === undefined || params.projectId === null)
        ? { ...params, projectId }
        : (params ?? {});
    const threadId =
      typeof payloadWithProject.threadId === "string" && payloadWithProject.threadId.length > 0
        ? (payloadWithProject.threadId as ThreadId)
        : this.defaultThreadId;
    const payload =
      threadId &&
      (payloadWithProject.threadId === undefined || payloadWithProject.threadId === null)
        ? { ...payloadWithProject, threadId }
        : payloadWithProject;
    const response = await fetch(this.bridgeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-t3-browser-token": this.authToken,
      },
      body: JSON.stringify({
        method,
        params: payload,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      result?: T;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `Desktop browser bridge failed with ${response.status}.`);
    }
    if (body.error) {
      throw new Error(body.error);
    }
    return body.result as T;
  }
}
