import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@sammorrowdrums/mcpi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type FauxProviderRegistration,
	type ImageContent,
	type Model,
	registerFauxProvider,
	type TextContent,
} from "@sammorrowdrums/mcpi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

// Mock stream that mimics AssistantMessageEventStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createAssistantMessage(model: Model<string>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession | undefined;
	let tempDir: string;
	let faux: FauxProviderRegistration | undefined;
	let model: Model<string>;
	let modelRuntime: ModelRuntime;
	let pendingPrompts: Promise<void>[];

	beforeEach(async () => {
		session = undefined;
		faux = undefined;
		pendingPrompts = [];
		tempDir = mkdtempSync(join(tmpdir(), "pi-concurrent-test-"));
		faux = registerFauxProvider();
		model = faux.getModel();
		const authStorage = AuthStorage.inMemory({
			[model.provider]: { type: "api_key", key: "faux-key" },
		});
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		modelRuntime = getModelRuntime(modelRegistry);
	});

	afterEach(async () => {
		try {
			await session?.abort();
		} finally {
			await Promise.allSettled(pendingPrompts);
			session?.dispose();
			faux?.unregister();
			delete (globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi;
			delete (globalThis as typeof globalThis & { testCommandRuns?: unknown }).testCommandRuns;
			if (tempDir && existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		}
	});

	function trackPrompt(prompt: Promise<void>): Promise<void> {
		pendingPrompts.push(prompt);
		return prompt;
	}

	async function waitForStreamStart(streamStarted: Promise<void>, prompt: Promise<void>): Promise<void> {
		await Promise.race([
			streamStarted,
			prompt.then(() => {
				throw new Error("Prompt completed before the stream started");
			}),
		]);
	}

	async function createSession() {
		const streamStarted = createDeferred();

		// Use a stream function that responds to abort
		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				streamStarted.resolve();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage(model, "") });
					const abort = () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantMessage(model, "Aborted"),
						});
					};
					if (options?.signal?.aborted) {
						abort();
					} else {
						options?.signal?.addEventListener("abort", abort, { once: true });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();

		const createdSession = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
		session = createdSession;

		return { session: createdSession, streamStarted: streamStarted.promise };
	}

	it("should throw when prompt() called while streaming", async () => {
		const { session: activeSession, streamStarted } = await createSession();

		const firstPrompt = trackPrompt(activeSession.prompt("First message"));
		await waitForStreamStart(streamStarted, firstPrompt);

		// Verify we're streaming
		expect(activeSession.isStreaming).toBe(true);

		// Second prompt should reject
		const secondPrompt = trackPrompt(activeSession.prompt("Second message"));
		await expect(secondPrompt).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);
	});

	it("should allow steer() while streaming", async () => {
		const { session: activeSession, streamStarted } = await createSession();

		const firstPrompt = trackPrompt(activeSession.prompt("First message"));
		await waitForStreamStart(streamStarted, firstPrompt);

		// steer should work while streaming
		expect(() => activeSession.steer("Steering message")).not.toThrow();
		expect(activeSession.pendingMessageCount).toBe(1);
	});

	it("should allow followUp() while streaming", async () => {
		const { session: activeSession, streamStarted } = await createSession();

		const firstPrompt = trackPrompt(activeSession.prompt("First message"));
		await waitForStreamStart(streamStarted, firstPrompt);

		// followUp should work while streaming
		expect(() => activeSession.followUp("Follow-up message")).not.toThrow();
		expect(activeSession.pendingMessageCount).toBe(1);
	});

	it("should queue extension-origin steering messages while streaming", async () => {
		const streamStarted = createDeferred();
		const steeringQueued = createDeferred();
		let sawSteeringMessage = false;
		let lastInputSource: string | undefined;
		const queueEvents: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];

		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context, options) => {
				const stream = new MockAssistantStream();
				streamStarted.resolve();
				queueMicrotask(() => {
					const userTexts = context.messages
						.filter((message) => message.role === "user")
						.map((message) => {
							if (typeof message.content === "string") {
								return message.content;
							}
							return message.content
								.filter((part): part is TextContent | ImageContent => typeof part === "object" && part !== null)
								.filter((part): part is TextContent => part.type === "text")
								.map((part) => part.text)
								.join("\n");
						});

					if (userTexts.includes("Steer from extension")) {
						sawSteeringMessage = true;
						stream.push({ type: "start", partial: createAssistantMessage(model, "") });
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage(model, "Steered"),
						});
						return;
					}

					stream.push({ type: "start", partial: createAssistantMessage(model, "") });
					const abort = () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantMessage(model, "Aborted"),
						});
					};
					if (options?.signal?.aborted) {
						abort();
					} else {
						options?.signal?.addEventListener("abort", abort, { once: true });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();

		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				(globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi = pi;
			},
			(pi) => {
				pi.on("input", async (event) => {
					lastInputSource = event.source;
				});
			},
		]);

		const activeSession = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		session = activeSession;
		activeSession.subscribe((event) => {
			if (event.type === "queue_update") {
				queueEvents.push({ steering: event.steering, followUp: event.followUp });
				if (event.steering.includes("Steer from extension")) {
					steeringQueued.resolve();
				}
			}
		});

		const firstPrompt = trackPrompt(activeSession.prompt("First message"));
		await waitForStreamStart(streamStarted.promise, firstPrompt);
		expect(activeSession.isStreaming).toBe(true);

		const pi = (
			globalThis as typeof globalThis & {
				testExtensionApi?: {
					sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
				};
			}
		).testExtensionApi;
		expect(pi).toBeDefined();

		pi!.sendUserMessage("Steer from extension", { deliverAs: "steer" });
		await Promise.race([
			steeringQueued.promise,
			firstPrompt.then(() => {
				throw new Error("Prompt completed before the steering message was queued");
			}),
		]);

		expect(activeSession.pendingMessageCount).toBe(1);
		expect(activeSession.getSteeringMessages()).toContain("Steer from extension");
		expect(lastInputSource).toBe("extension");
		expect(queueEvents.some((event) => event.steering.includes("Steer from extension"))).toBe(true);

		await activeSession.abort();
		await Promise.allSettled([firstPrompt]);

		expect(sawSteeringMessage).toBe(true);
	});

	it("should allow prompt() after previous completes", async () => {
		// Create session with a stream that completes immediately
		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage(model, "") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage(model, "Done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();

		const activeSession = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
		session = activeSession;

		// First prompt completes
		await trackPrompt(activeSession.prompt("First message"));

		// Should not be streaming anymore
		expect(activeSession.isStreaming).toBe(false);

		// Second prompt should work
		await expect(trackPrompt(activeSession.prompt("Second message"))).resolves.not.toThrow();
	});

	it("should wait for queued agent events before emitting tool_call", async () => {
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
					if (toolResultCount > 0) {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
							{ type: "toolCall", id: "toolu_2", name: "dummy", arguments: { q: "y" } },
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();

		const activeSession = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});
		session = activeSession;

		const snapshots: string[][] = [];
		const sessionWithRunner = activeSession as unknown as {
			_extensionRunner?: {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: { type: string; message?: { role?: string } }) => Promise<void>;
				emitMessageEnd: (event: { type: string; message?: { role?: string } }) => Promise<undefined>;
				emitToolCall: (event: { type: string; toolCallId: string }) => Promise<undefined>;
				emitInput: (
					text: string,
					images: unknown,
					source: "interactive" | "rpc" | "extension",
					streamingBehavior?: "steer" | "followUp",
				) => Promise<{ action: "continue" }>;
				emitBeforeAgentStart: (
					prompt: string,
					images: unknown,
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<undefined>;
				invalidate: (message?: string) => void;
			};
		};
		sessionWithRunner._extensionRunner = {
			hasHandlers: (eventType) => eventType === "tool_call",
			emit: async () => {},
			emitMessageEnd: async () => undefined,
			emitToolCall: async () => {
				snapshots.push(
					sessionManager
						.getEntries()
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message.role),
				);
				return undefined;
			},
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async () => undefined,
			invalidate: () => {},
		};

		await trackPrompt(activeSession.prompt("hi"));
		await activeSession.agent.waitForIdle();

		expect(snapshots).toEqual([
			["user", "assistant"],
			["user", "assistant"],
		]);
	});

	it("should persist message_end events in order with slow extension handlers", async () => {
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");

					if (hasToolResult) {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "text", text: "calling tool" },
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();

		const activeSession = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});
		session = activeSession;

		const sessionWithRunner = activeSession as unknown as {
			_extensionRunner?: {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: { type: string; message?: { role?: string } }) => Promise<void>;
				emitMessageEnd: (event: { type: string; message?: { role?: string } }) => Promise<undefined>;
				emitInput: (
					text: string,
					images: unknown,
					source: "interactive" | "rpc" | "extension",
					streamingBehavior?: "steer" | "followUp",
				) => Promise<{ action: "continue" }>;
				emitBeforeAgentStart: (
					prompt: string,
					images: unknown,
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<undefined>;
				invalidate: (message?: string) => void;
			};
		};
		sessionWithRunner._extensionRunner = {
			hasHandlers: () => false,
			emit: async () => {},
			emitMessageEnd: async (event) => {
				if (event.type === "message_end" && event.message?.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, 40));
				}
				return undefined;
			},
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async () => undefined,
			invalidate: () => {},
		};

		await trackPrompt(activeSession.prompt("hi"));
		await activeSession.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const messageEntries = sessionManager.getEntries().filter((entry) => entry.type === "message");
		expect(messageEntries.map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});
});
