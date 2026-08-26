import { describe, expect, it } from "vitest";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../src/api/cloudflare.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "../src/providers/cloudflare-ai-gateway.models.ts";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "../src/providers/cloudflare-workers-ai.models.ts";

describe("Cloudflare model catalogs", () => {
	it("mirrors Workers AI models through the AI Gateway compatibility endpoint", () => {
		const workersModels = Object.values(CLOUDFLARE_WORKERS_AI_MODELS);
		const gatewayModels = new Map(Object.values(CLOUDFLARE_AI_GATEWAY_MODELS).map((model) => [model.id, model]));

		expect(workersModels.length).toBeGreaterThan(0);
		for (const model of workersModels) {
			expect(gatewayModels.get(`workers-ai/${model.id}`)).toMatchObject({
				id: `workers-ai/${model.id}`,
				name: model.name,
				api: "openai-completions",
				provider: "cloudflare-ai-gateway",
				baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
				reasoning: model.reasoning,
				input: model.input,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			});
		}
	});
});
