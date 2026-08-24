import { Agent } from "@sammorrowdrums/mcpi-agent-core";
import { createModels } from "@sammorrowdrums/mcpi-ai";
import { anthropicProvider } from "@sammorrowdrums/mcpi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
