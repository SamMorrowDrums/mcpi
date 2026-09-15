import type { Api, AssistantMessage, JsonValue, ProviderId } from "../types.ts";

/** Exact provider-owned assistant content retained for same-model replay. */
export interface ProviderReplay {
	provider: ProviderId;
	api: Api;
	model: string;
	content: JsonValue[];
}

/**
 * Internal assistant-message extension. Provider replay data is deliberately
 * absent from the public content union so native server tools cannot be
 * mistaken for client-executed tool calls.
 */
export type ProviderReplayAssistantMessage = AssistantMessage & {
	providerReplay?: ProviderReplay;
};
