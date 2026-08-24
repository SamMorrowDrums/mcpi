import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type McpiCommandContext, mcpiCommand } from "./commands/mcpi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

export type ExperimentalCliContext = McpiCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = mcpiCommand.command(serverCommand).command(clientCommand);
