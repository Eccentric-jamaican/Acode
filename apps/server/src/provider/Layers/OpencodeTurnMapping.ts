export type OpencodeInteractionMode = "default" | "plan";
export type OpencodeAgent = "build" | "plan";

export interface OpencodePromptAsyncBody {
  readonly model: {
    readonly providerID: string;
    readonly modelID: string;
  };
  readonly parts: ReadonlyArray<Record<string, unknown>>;
  readonly agent?: OpencodeAgent;
}

export function opencodeAgentForInteractionMode(
  interactionMode: OpencodeInteractionMode | undefined,
): OpencodeAgent | undefined {
  if (interactionMode === "plan") return "plan";
  if (interactionMode === "default") return "build";
  return undefined;
}

export function buildOpencodePromptAsyncBody(input: {
  readonly providerID: string;
  readonly modelID: string;
  readonly parts: ReadonlyArray<Record<string, unknown>>;
  readonly interactionMode?: OpencodeInteractionMode;
}): OpencodePromptAsyncBody {
  const agent = opencodeAgentForInteractionMode(input.interactionMode);
  return {
    model: {
      providerID: input.providerID,
      modelID: input.modelID,
    },
    parts: input.parts,
    ...(agent !== undefined ? { agent } : {}),
  };
}
