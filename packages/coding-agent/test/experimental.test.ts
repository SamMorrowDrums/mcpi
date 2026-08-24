import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalMcpiExperimental = process.env.MCPI_EXPERIMENTAL;
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;

	afterEach(() => {
		if (originalMcpiExperimental === undefined) {
			delete process.env.MCPI_EXPERIMENTAL;
		} else {
			process.env.MCPI_EXPERIMENTAL = originalMcpiExperimental;
		}
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when MCPI_EXPERIMENTAL is unset", () => {
		delete process.env.MCPI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MCPI_EXPERIMENTAL is empty", () => {
		process.env.MCPI_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when MCPI_EXPERIMENTAL is set to 1", () => {
		process.env.MCPI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when MCPI_EXPERIMENTAL is set to 0", () => {
		process.env.MCPI_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MCPI_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.MCPI_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("does not accept the removed PI_EXPERIMENTAL alias", () => {
		delete process.env.MCPI_EXPERIMENTAL;
		process.env.PI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
