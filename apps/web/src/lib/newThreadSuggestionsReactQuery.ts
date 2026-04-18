import type {
  ProviderKind,
  ServerSuggestNewThreadTasksResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

const EMPTY_RESULT: ServerSuggestNewThreadTasksResult = {
  suggestions: [],
};

export const newThreadSuggestionsQueryKeys = {
  all: ["new-thread-suggestions"] as const,
  refine: (
    provider: ProviderKind,
    cwd: string | null,
    projectName: string | null,
    selectedModel: string | null,
  ) =>
    [
      "new-thread-suggestions",
      "refine",
      provider,
      cwd,
      projectName,
      selectedModel,
    ] as const,
};

export function refineNewThreadSuggestionsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  projectName: string | null;
  selectedModel: string | null;
  enabled: boolean;
}) {
  return queryOptions({
    queryKey: newThreadSuggestionsQueryKeys.refine(
      input.provider,
      input.cwd,
      input.projectName,
      input.selectedModel,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.projectName) {
        throw new Error("New-thread suggestion refinement is unavailable.");
      }

      return api.server.suggestNewThreadTasks({
        provider: input.provider,
        cwd: input.cwd,
        projectName: input.projectName,
        selectedModel: input.selectedModel,
      });
    },
    enabled: input.enabled && input.cwd !== null && input.projectName !== null,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous ?? EMPTY_RESULT,
    retry: false,
  });
}
