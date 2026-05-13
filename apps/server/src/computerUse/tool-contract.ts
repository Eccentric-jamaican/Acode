export interface ToolContentImage {
	type: "image";
	data: string;
	mimeType: "image/png";
}

export interface ToolContentText {
	type: "text";
	text: string;
}

export type ToolContentPart = ToolContentText | ToolContentImage;

export interface AgentToolResult<TDetails> {
	content: ToolContentPart[];
	details: TDetails;
}

export type AgentToolUpdateCallback<TDetails> =
	(update: AgentToolResult<TDetails>) => Promise<void> | void;

export interface ExtensionUI {
	select(
		prompt: string,
		options: string[],
		optionsObj?: { signal?: AbortSignal },
	): Promise<string | undefined>;
	notify(message: string, level?: string): void;
}

export interface ExtensionContextLike {
	hasUI: boolean;
	ui: ExtensionUI;
	sessionManager: {
		getBranch(): any[];
	};
}
