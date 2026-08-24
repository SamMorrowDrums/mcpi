import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createMcpiCodingAgentHarness } from "./mcpi-harness.ts";

const mcpiCodingAgentHarness = createMcpiCodingAgentHarness({ noTools: "all" });

describeEval("mcpi Coding Agent smoke", { harness: mcpiCodingAgentHarness }, (it) => {
	it("runs a basic prompt end to end", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");

		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage.provider).toBe(process.env.MCPI_PROVIDER);
		expect(result.usage.model).toBe(process.env.MCPI_MODEL);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
