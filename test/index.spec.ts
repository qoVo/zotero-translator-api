import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { buildGlossaryPrompt } from "../src/glossary";
import { cleanSourceText, extractPaperContext } from "../src/prompt";
import { createThinkFilter, stripThinking } from "../src/stream";

const API_KEY = "test-key";
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const QWEN = "@cf/qwen/qwen3-30b-a3b-fp8";
const GLM = "@cf/zai-org/glm-4.7-flash";
const NO_THINKING = { enable_thinking: false };

// 与脚手架一致：让 Request 的类型匹配 worker.fetch() 的参数。
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

type RunInputs = {
	messages: Array<{ role: string; content: string }>;
} & Record<string, unknown>;

type Respond = (model: string, inputs: RunInputs) => unknown;

function createEnv(respond: Respond, { cache = false } = {}) {
	const calls: Array<{ model: string; inputs: RunInputs }> = [];
	const testEnv = {
		ZOTERO_API_KEY: API_KEY,
		TRANSLATION_CACHE: cache ? env.TRANSLATION_CACHE : undefined,
		AI: {
			run: async (model: string, inputs: RunInputs) => {
				calls.push({ model, inputs });
				return respond(model, inputs);
			},
		},
	} as unknown as Env;

	return { env: testEnv, calls };
}

const reply = (content: string, finish_reason = "stop") => () => ({
	choices: [{ message: { content }, finish_reason }],
});

function chatRequest(
	body: unknown,
	{ key = API_KEY, headers = {} as Record<string, string> } = {},
) {
	return new IncomingRequest("https://example.com/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, ...headers },
		body: JSON.stringify(body),
	});
}

/**
 * 读完响应体后再等待 ctx.waitUntil，流式输出结束后才会写缓存。
 */
async function send(
	testEnv: Env,
	request: Request<unknown, IncomingRequestCfProperties>,
) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);
	const text = await response.text();
	await waitOnExecutionContext(ctx);

	return {
		response,
		text,
		json: () => JSON.parse(text),
		header: (name: string) => response.headers.get(name),
	};
}

function streamOf(pieces: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const piece of pieces) {
				controller.enqueue(encoder.encode(piece));
			}
			controller.close();
		},
	});
}

/**
 * 与 Zotero PDF Translate 插件解析 Chat Completions 流的方式一致：
 * 直接按 "data:" 切分，再逐段 JSON.parse。
 */
function parseLikeZotero(sse: string) {
	let result = "";
	let finished = false;

	for (const data of sse.split("data:")) {
		if (!data.trim()) continue;
		try {
			const choice = JSON.parse(data).choices[0];
			result += choice.delta?.content || "";
			finished ||= choice.finish_reason != null;
		} catch {
			// [DONE]
		}
	}

	return { result, finished };
}

/**
 * 与新版插件一致：system 是插件的翻译指令（可附带论文背景），
 * user 只有原文，temperature 默认 1.0。
 */
const pluginBody = (
	sourceText: unknown,
	extra: Record<string, unknown> = {},
) => ({
	model: "",
	temperature: 1.0,
	messages: [
		{ role: "system", content: "As an academic expert, translate from en to zh." },
		{ role: "user", content: sourceText },
	],
	...extra,
});

describe("buildGlossaryPrompt", () => {
	it("matches hyphen, space and plural variants", () => {
		const prompt = buildGlossaryPrompt(
			"We use self attention over multiscale features and predict bounding boxes with a pretrained model.",
		);

		expect(prompt).toContain("self-attention → 自注意力");
		expect(prompt).toContain("multi-scale feature → 多尺度特征");
		expect(prompt).toContain("bounding box → 边界框");
		expect(prompt).toContain("pre-trained model → 预训练模型");
	});

	it("covers terms models got wrong in live tests", () => {
		const prompt = buildGlossaryPrompt(
			"Unlike one-stream trackers, Siamese-based trackers use two branches.",
		);

		expect(prompt).toContain("one-stream → 单流");
		expect(prompt).toContain("siamese → 孪生");
	});

	it("lists spelling variants of one term only once", () => {
		const prompt = buildGlossaryPrompt("cross-attention and cross attention");
		expect(prompt.match(/交叉注意力/g)).toHaveLength(1);
	});

	it("does not match inside other words", () => {
		expect(buildGlossaryPrompt("disocclusion handling")).toBe("");
	});

	it("puts longer terms first", () => {
		const prompt = buildGlossaryPrompt("a similar distractor");
		expect(prompt.indexOf("similar distractor")).toBeLessThan(
			prompt.indexOf("distractor →"),
		);
	});
});

describe("think filter", () => {
	it("removes the leading empty think block", () => {
		expect(stripThinking("<think>\n\n</think>\n\n译文")).toBe("译文");
		expect(stripThinking("  普通译文 ")).toBe("普通译文");
	});

	it("handles tags split across chunks", () => {
		const filter = createThinkFilter();
		const pieces = ["\n<th", "ink>推理", "内容</thi", "nk>\n", "\n译", "文<b>"];
		const output = pieces.map((piece) => filter.push(piece)).join("");
		expect(output + filter.flush()).toBe("译文<b>");
	});

	it("drops an unterminated think block", () => {
		expect(stripThinking("<think>还在思考")).toBe("");
	});
});

describe("cleanSourceText", () => {
	it("replaces ligatures and removes soft hyphens", () => {
		expect(cleanSourceText("ﬁlter ﬂow eﬀect hy­phen")).toBe(
			"filter flow effect hyphen",
		);
	});

	it("joins words hyphenated across lines", () => {
		expect(cleanSourceText("the tem-\nplate update")).toBe(
			"the template update",
		);
		expect(cleanSourceText("based on Siam-\nRPN and 3-\nD")).toBe(
			"based on Siam-RPN and 3-D",
		);
	});

	it("joins lines inside a paragraph but keeps paragraph breaks", () => {
		expect(
			cleanSourceText("first line\r\nsecond line  \n\n\n  next paragraph\n"),
		).toBe("first line second line\n\nnext paragraph");
	});
});

describe("extractPaperContext", () => {
	it("returns the title and abstract appended by the plugin", () => {
		const system =
			"Translate from en to zh.\n\nContext from the academic paper:\nPaper Title: OSTrack\n\nPaper Abstract: One-stream tracking.";

		expect(extractPaperContext(system)).toBe(
			"Paper Title: OSTrack\n\nPaper Abstract: One-stream tracking.",
		);
		expect(extractPaperContext("Translate from en to zh.")).toBe("");
	});
});

describe("Worker", () => {
	it("health check does not call the model", async () => {
		const { env: testEnv, calls } = createEnv(reply("x"));
		const { response, json } = await send(
			testEnv,
			new IncomingRequest("https://example.com/health"),
		);

		expect(response.status).toBe(200);
		expect(json().models.map((model: { name: string }) => model.name)).toEqual([
			"gemma",
			"qwen3",
			"glm",
		]);
		expect(calls).toHaveLength(0);
	});

	it("rejects every request when the API key is not configured", async () => {
		const { env: testEnv } = createEnv(reply("x"));
		delete (testEnv as Partial<Env>).ZOTERO_API_KEY;

		const { response } = await send(
			testEnv,
			chatRequest(pluginBody("hi"), { key: "undefined" }),
		);

		expect(response.status).toBe(500);
	});

	it("returns 401 for a wrong key", async () => {
		const { env: testEnv, calls } = createEnv(reply("x"));
		const { response } = await send(
			testEnv,
			chatRequest(pluginBody("hi"), { key: "wrong" }),
		);

		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("returns 400 for a null JSON body", async () => {
		const { env: testEnv } = createEnv(reply("x"));
		const { response } = await send(testEnv, chatRequest(null));
		expect(response.status).toBe(400);
	});

	it("lists models only with a valid key", async () => {
		const { env: testEnv } = createEnv(reply("x"));
		const models = (key: string) =>
			send(
				testEnv,
				new IncomingRequest("https://example.com/v1/models", {
					headers: { Authorization: `Bearer ${key}` },
				}),
			);

		expect((await models("wrong")).response.status).toBe(401);

		const { json } = await models(API_KEY);
		expect(json().data.map((model: { id: string }) => model.id)).toEqual([
			"gemma",
			"qwen3",
			"glm",
		]);
	});

	it("builds the prompt from worker rules, paper context, glossary and cleaned text", async () => {
		const { env: testEnv, calls } = createEnv(
			reply("<think>\n\n</think>\n\n译文"),
		);

		const { json, header } = await send(
			testEnv,
			chatRequest({
				...pluginBody(""),
				messages: [
					{
						role: "system",
						content:
							"As an academic expert, translate.\n\nContext from the academic paper:\nPaper Title: MemTrack",
					},
					{
						role: "user",
						content: "Handle full oc-\nclusion with a\nmemory bank.",
					},
				],
			}),
		);

		expect(json().choices[0].message.content).toBe("译文");
		expect(json().model).toBe(GEMMA);
		expect(header("X-Translation-Model")).toBe(GEMMA);

		const [{ model, inputs }] = calls;
		const [system, user] = inputs.messages;

		expect(model).toBe(GEMMA);
		expect(inputs.chat_template_kwargs).toEqual(NO_THINKING);
		expect(inputs.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(system.content).not.toContain("As an academic expert");
		expect(system.content).toContain("Paper Title: MemTrack");
		expect(system.content).toContain("full occlusion → 完全遮挡");
		expect(system.content).toContain("memory bank → 记忆库");
		expect(user.content).toBe("Handle full occlusion with a memory bank.");
		expect(inputs.temperature).toBe(0.3);
		expect(inputs.max_tokens).toBe(4096);
	});

	it("accepts OpenAI content parts", async () => {
		const { env: testEnv, calls } = createEnv(() => ({ response: "译文" }));

		await send(
			testEnv,
			chatRequest(
				pluginBody([
					{ type: "text", text: "Hello " },
					{ type: "text", text: "world" },
				]),
			),
		);

		expect(calls[0].inputs.messages[1].content).toBe("Hello world");
	});

	it("selects qwen3 by name and disables thinking with /no_think", async () => {
		const { env: testEnv, calls } = createEnv(reply("译文"));

		const { header } = await send(
			testEnv,
			chatRequest(pluginBody("Hello", { model: "Qwen3" })),
		);

		expect(calls[0].model).toBe(QWEN);
		expect(calls[0].inputs.chat_template_kwargs).toBeUndefined();
		expect(calls[0].inputs.messages[1].content).toBe("Hello\n/no_think");
		expect(header("X-Translation-Model")).toBe(QWEN);
	});

	it("selects a model by its full Workers AI ID", async () => {
		const { env: testEnv, calls } = createEnv(reply("译文"));

		await send(testEnv, chatRequest(pluginBody("Hello", { model: GLM })));

		expect(calls[0].model).toBe(GLM);
		expect(calls[0].inputs.chat_template_kwargs).toEqual(NO_THINKING);
	});

	it("uses the default model for an unknown model name", async () => {
		const { env: testEnv, calls } = createEnv(reply("译文"));

		await send(
			testEnv,
			chatRequest(pluginBody("Hello", { model: "gpt-4o-mini" })),
		);

		expect(calls[0].model).toBe(GEMMA);
	});

	it("falls back to the next model when the first one fails", async () => {
		const { env: testEnv, calls } = createEnv((model) => {
			if (model === GEMMA) {
				throw new Error("3040: Capacity temporarily exceeded");
			}
			return reply("备用译文")();
		});

		const { response, json } = await send(
			testEnv,
			chatRequest(pluginBody("Hello")),
		);

		expect(response.status).toBe(200);
		expect(calls.map((call) => call.model)).toEqual([GEMMA, QWEN]);
		expect(json().choices[0].message.content).toBe("备用译文");
	});

	it("returns 502 when every model fails", async () => {
		const { env: testEnv } = createEnv(() => {
			throw new Error("boom");
		});

		const { response, json } = await send(
			testEnv,
			chatRequest(pluginBody("Hello")),
		);

		expect(response.status).toBe(502);
		expect(json().error.message).toBe("boom");
	});

	it("converts the stream into OpenAI chunks the Zotero plugin can parse", async () => {
		const upstream = [
			'data: {"choices":[{"delta":{"content":"<think>\\n\\n</th"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"ink>\\n\\n训练"}}]}\n',
			'\ndata: {"response":"数据 data: 很少"}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
			"data: [DONE]\n\n",
		];
		const { env: testEnv, calls } = createEnv(() => streamOf(upstream));

		const { text, header } = await send(
			testEnv,
			chatRequest(pluginBody("Training data", { stream: true })),
		);

		expect(calls[0].inputs.stream).toBe(true);
		expect(header("Content-Type")).toContain("text/event-stream");
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
		expect(text).toContain('"finish_reason":"length"');
		expect(parseLikeZotero(text)).toEqual({
			result: "训练数据 data: 很少",
			finished: true,
		});
	});

	describe("translation cache", () => {
		it("serves a repeated translation from cache, also as a stream", async () => {
			const { env: testEnv, calls } = createEnv(reply("缓存译文"), {
				cache: true,
			});
			const body = pluginBody("Cache me once.");

			const first = await send(testEnv, chatRequest(body));
			expect(first.header("X-Translation-Cache")).toBe("MISS");

			const second = await send(testEnv, chatRequest(body));
			expect(second.header("X-Translation-Cache")).toBe("HIT");
			expect(second.json().choices[0].message.content).toBe("缓存译文");

			const streamed = await send(
				testEnv,
				chatRequest({ ...body, stream: true }),
			);
			expect(streamed.header("X-Translation-Cache")).toBe("HIT");
			expect(parseLikeZotero(streamed.text)).toEqual({
				result: "缓存译文",
				finished: true,
			});

			expect(calls).toHaveLength(1);
		});

		it("caches the text of a finished stream", async () => {
			const { env: testEnv, calls } = createEnv(
				() =>
					streamOf([
						'data: {"response":"流式"}\n\n',
						'data: {"response":"译文"}\n\n',
						"data: [DONE]\n\n",
					]),
				{ cache: true },
			);
			const body = pluginBody("Stream then cache.");

			await send(testEnv, chatRequest({ ...body, stream: true }));
			const cached = await send(testEnv, chatRequest(body));

			expect(cached.header("X-Translation-Cache")).toBe("HIT");
			expect(cached.json().choices[0].message.content).toBe("流式译文");
			expect(calls).toHaveLength(1);
		});

		it("does not cache a truncated translation", async () => {
			const { env: testEnv, calls } = createEnv(
				reply("被截断的译", "length"),
				{ cache: true },
			);
			const body = pluginBody("Too long to finish.");

			await send(testEnv, chatRequest(body));
			const again = await send(testEnv, chatRequest(body));

			expect(again.header("X-Translation-Cache")).toBe("MISS");
			expect(calls).toHaveLength(2);
		});

		it("re-translates with Cache-Control: no-cache and stores the new result", async () => {
			let count = 0;
			const { env: testEnv, calls } = createEnv(
				() => reply(`第 ${++count} 次译文`)(),
				{ cache: true },
			);
			const body = pluginBody("Translate again.");

			await send(testEnv, chatRequest(body));
			const fresh = await send(
				testEnv,
				chatRequest(body, { headers: { "Cache-Control": "no-cache" } }),
			);
			expect(fresh.header("X-Translation-Cache")).toBe("BYPASS");
			expect(fresh.json().choices[0].message.content).toBe("第 2 次译文");

			const cached = await send(testEnv, chatRequest(body));
			expect(cached.json().choices[0].message.content).toBe("第 2 次译文");
			expect(calls).toHaveLength(2);
		});

		it("uses a separate cache entry per model", async () => {
			const { env: testEnv, calls } = createEnv(
				(model) => reply(model === GEMMA ? "Gemma 译文" : "千问译文")(),
				{ cache: true },
			);
			const text = "Same text, two models.";

			await send(testEnv, chatRequest(pluginBody(text)));
			const other = await send(
				testEnv,
				chatRequest(pluginBody(text, { model: "qwen3" })),
			);

			expect(other.header("X-Translation-Cache")).toBe("MISS");
			expect(other.json().choices[0].message.content).toBe("千问译文");
			expect(calls).toHaveLength(2);
		});
	});
});
