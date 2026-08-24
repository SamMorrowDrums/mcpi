import { describe, expect, it } from "vitest";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("mcpi user agent", () => {
	it("uses the mcpi product identity", () => {
		const userAgent = getPiUserAgent();

		expect(userAgent).toMatch(/^mcpi \(/);
		expect(userAgent).not.toMatch(/^pi \(/);
	});
});
