import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions, ThinkingLevel } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	max_tokens?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;

	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

// Every ThinkingLevel, paired with the Anthropic effort it must reach. `xhigh` and
// `max` are only reachable because Opus 5 declares them in thinkingLevelMap; without
// those entries mapThinkingLevelToEffort silently degrades both to "high".
const EFFORT_BY_LEVEL: ReadonlyArray<readonly [ThinkingLevel, string]> = [
	["minimal", "low"],
	["low", "low"],
	["medium", "medium"],
	["high", "high"],
	["xhigh", "xhigh"],
	["max", "max"],
];

describe("Claude Opus 5 thinking levels", () => {
	it("declares native xhigh and max in its thinking level map", () => {
		const model = getModel("anthropic", "claude-opus-5");

		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(model.thinkingLevelMap?.max).toBe("max");
	});

	it.each(EFFORT_BY_LEVEL)("maps thinking level %s to adaptive effort %s", async (level, effort) => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5"), { reasoning: level });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort });
	});

	it("reaches max effort rather than degrading to high", async () => {
		const max = await capturePayload(getModel("anthropic", "claude-opus-5"), { reasoning: "max" });
		const high = await capturePayload(getModel("anthropic", "claude-opus-5"), { reasoning: "high" });

		expect(max.output_config?.effort).toBe("max");
		expect(max.output_config?.effort).not.toBe(high.output_config?.effort);
	});

	it("sends no thinking budget alongside adaptive effort", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5"), { reasoning: "max" });

		// Adaptive thinking is effort-driven; a budget_tokens field would mean the
		// legacy budget path ran instead.
		expect(payload.thinking?.budget_tokens).toBeUndefined();
	});

	it("disables thinking when no reasoning level is requested", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("engages adaptive thinking on the GitHub Copilot Opus 5 variant", async () => {
		const model = getModel("github-copilot", "claude-opus-5");
		expect(model.compat?.forceAdaptiveThinking).toBe(true);

		const payload = await capturePayload(model, { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps minimal to low on the GitHub Copilot Opus 5 variant", async () => {
		// Copilot's catalog entry adds an explicit minimal -> low mapping.
		const payload = await capturePayload(getModel("github-copilot", "claude-opus-5"), { reasoning: "minimal" });

		expect(payload.output_config).toEqual({ effort: "low" });
	});
});
