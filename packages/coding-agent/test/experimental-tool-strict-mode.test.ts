import { afterEach, describe, expect, it } from "vitest";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../src/core/tools/index.ts";

function createBuiltInTools() {
	return [
		createReadToolDefinition(process.cwd()),
		createBashToolDefinition(process.cwd()),
		createEditToolDefinition(process.cwd()),
		createWriteToolDefinition(process.cwd()),
	];
}

describe("experimental strict built-in tools", () => {
	const originalMcpiExperimental = process.env.MCPI_EXPERIMENTAL;

	afterEach(() => {
		if (originalMcpiExperimental === undefined) delete process.env.MCPI_EXPERIMENTAL;
		else process.env.MCPI_EXPERIMENTAL = originalMcpiExperimental;
	});

	it("only enables strict-prefer sampling in experimental mode", () => {
		delete process.env.MCPI_EXPERIMENTAL;
		const normalTools = createBuiltInTools();
		process.env.MCPI_EXPERIMENTAL = "1";
		const experimentalTools = createBuiltInTools();

		for (const [index, tool] of experimentalTools.entries()) {
			expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
			expect(tool.parameters).toEqual(normalTools[index]?.parameters);
			expect(normalTools[index]?.constrainedSampling).toBeUndefined();
		}
	});
});
