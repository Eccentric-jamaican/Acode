import { describe, expect, it } from "vitest";

import {
  buildSubagentIdentityDirectory,
  extractSubagentIdentityHints,
  mergeSubagentIdentityHints,
  resolveSubagentIdentityFromDirectory,
} from "./subagents";

describe("subagents", () => {
  it("extracts receiver agent identity from codex-style collaboration payloads", () => {
    const hints = extractSubagentIdentityHints({
      receiverAgents: [
        {
          threadId: "child-thread-1",
          agentId: "agent-1",
          agentNickname: "Scout",
          agentRole: "researcher",
        },
      ],
    });

    expect(hints).toEqual([
      {
        providerThreadId: "child-thread-1",
        agentId: "agent-1",
        nickname: "Scout",
        role: "researcher",
      },
    ]);
  });

  it("extracts user-facing names from codex thread metadata aliases", () => {
    const hints = extractSubagentIdentityHints({
      providerThreadId: "child-thread-named",
      agentId: "agent-named",
      name: "Policy Reader",
      role: "explorer",
    });

    expect(hints).toEqual([
      {
        providerThreadId: "child-thread-named",
        agentId: "agent-named",
        nickname: "Policy Reader",
        role: "explorer",
      },
    ]);
  });

  it("extracts source subagent identity from claude-style nested payloads", () => {
    const hints = extractSubagentIdentityHints({
      source: {
        subAgent: {
          thread_spawn: {
            threadId: "child-thread-2",
            agentId: "agent-2",
            agentNickname: "Harper",
            agentRole: "reviewer",
          },
        },
      },
    });

    expect(hints).toEqual([
      {
        providerThreadId: "child-thread-2",
        agentId: "agent-2",
        nickname: "Harper",
        role: "reviewer",
      },
    ]);
  });

  it("merges incremental hints without losing earlier fields", () => {
    const merged = mergeSubagentIdentityHints(
      {
        providerThreadId: "child-thread-3",
        agentId: "agent-3",
        nickname: "Locke",
      },
      {
        providerThreadId: "child-thread-3",
        role: "explorer",
        status: "running",
      },
    );

    expect(merged).toEqual({
      providerThreadId: "child-thread-3",
      agentId: "agent-3",
      nickname: "Locke",
      role: "explorer",
      status: "running",
    });
  });

  it("resolves identity by provider thread id or agent id", () => {
    const directory = buildSubagentIdentityDirectory([
      {
        providerThreadId: "child-thread-4",
        agentId: "agent-4",
        nickname: "Nova",
        role: "planner",
      },
    ]);

    expect(
      resolveSubagentIdentityFromDirectory(directory, { providerThreadId: "child-thread-4" }),
    ).toEqual({
      providerThreadId: "child-thread-4",
      agentId: "agent-4",
      nickname: "Nova",
      role: "planner",
    });
    expect(resolveSubagentIdentityFromDirectory(directory, { agentId: "agent-4" })).toEqual({
      providerThreadId: "child-thread-4",
      agentId: "agent-4",
      nickname: "Nova",
      role: "planner",
    });
  });
});
