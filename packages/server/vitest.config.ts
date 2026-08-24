import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [
			{
				find: /^@sammorrowdrums\/mcpi-protocol$/,
				replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			},
			{
				find: /^@sammorrowdrums\/mcpi-ai$/,
				replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
			},
		],
	},
});
