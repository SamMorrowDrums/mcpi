import { describe, expect, it } from "vitest";
import { resolveModelSelection } from "../src/mcpi-harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model over environment defaults", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ MCPI_PROVIDER: "openai-codex", MCPI_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults when the harness has no explicit model", () => {
		expect(
			resolveModelSelection(undefined, {
				MCPI_PROVIDER: " openai-codex ",
				MCPI_MODEL: " gpt-5.6-sol ",
			}),
		).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([
		[undefined, {}],
		[undefined, { MCPI_PROVIDER: "openai-codex" }],
		[undefined, { MCPI_MODEL: "gpt-5.6-sol" }],
		[
			{ provider: "", id: "gpt-5.6-sol" },
			{ MCPI_PROVIDER: "openai-codex", MCPI_MODEL: "gpt-5.6-sol" },
		],
	] as const)("rejects an incomplete model selection", (explicitModel, environment) => {
		expect(() => resolveModelSelection(explicitModel, environment)).toThrow(
			"Select a harness model explicitly or set both MCPI_PROVIDER and MCPI_MODEL as defaults.",
		);
	});
});
