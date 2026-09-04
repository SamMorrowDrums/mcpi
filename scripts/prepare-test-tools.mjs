#!/usr/bin/env node

import { ensureTool } from "../packages/coding-agent/dist/utils/tools-manager.js";

const reportStatus = (status) => {
	console.log(status.message);
};

const [fdPath, rgPath] = await Promise.all([ensureTool("fd", reportStatus), ensureTool("rg", reportStatus)]);

if (!fdPath || !rgPath) {
	throw new Error("Tests require the managed fd and rg binaries");
}
