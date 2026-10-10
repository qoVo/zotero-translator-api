import {
	buildCacheKey,
	readCache,
	writeCache,
	type CacheStatus,
} from "./cache";
import { MODELS, resolveModels, runWithFallback } from "./models";
import {
	buildSystemPrompt,
	cleanSourceText,
	extractPaperContext,
	type ChatMessage,
} from "./prompt";
import { stripThinking, textToOpenAIStream, toOpenAIStream } from "./stream";

/*
 * 插件传来的 content 可能是字符串，也可能是 OpenAI 的
 * [{ type: "text", text: "..." }] 分段格式。
 */
interface IncomingMessage {
	role?: unknown;
	content?: unknown;
}

interface ChatCompletionRequest {
	model?: unknown;
	messages?: IncomingMessage[];
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	/** 设为 false 时跳过缓存读取，重新翻译 */
	cache?: boolean;
}

interface WorkersAIResult {
	choices?: Array<{
		index?: number;
		finish_reason?: string | null;
		message?: {
			role?: string;
			content?: string | null;
		};
	}>;
	response?: string | null;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

const MAX_SOURCE_LENGTH = 50_000;

function errorResponse(
	message: string,
	status: number,
	type = "invalid_request_error",
): Response {
	return Response.json(
		{
			error: {
				message,
				type,
			},
		},
		{ status },
	);
}

function clampNumber(
	value: unknown,
	minimum: number,
	maximum: number,
	defaultValue: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return defaultValue;
	}

	return Math.min(Math.max(value, minimum), maximum);
}

function contentToText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("");
	}

	return "";
}

const encoder = new TextEncoder();

/**
 * 先做 SHA-256 让两边长度一致，再用常量时间比较，
 * 避免通过响应耗时逐字符猜出密钥。
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
	const [hashA, hashB] = await Promise.all(
		[a, b].map((value) =>
			crypto.subtle.digest("SHA-256", encoder.encode(value)),
		),
	);

	return crypto.subtle.timingSafeEqual(hashA, hashB);
}

/**
 * 通过响应头告诉调用方实际使用的模型和缓存状态，方便排查。
 */
function translationHeaders(
	modelId: string,
	cacheStatus: CacheStatus,
	stream: boolean,
): Record<string, string> {
	return {
		"X-Translation-Model": modelId,
		"X-Translation-Cache": cacheStatus,
		...(stream
			? {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache",
				}
			: {}),
	};
}

function completionResponse(
	text: string,
	modelId: string,
	finishReason: string,
	usage: WorkersAIResult["usage"],
	headers: Record<string, string>,
): Response {
	return Response.json(
		{
			id: `chatcmpl-${crypto.randomUUID()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: text,
					},
					finish_reason: finishReason,
				},
			],
			usage: usage ?? {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
			},
		},
		{ headers },
	);
}

async function handleChatCompletion(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	let body: ChatCompletionRequest;

	try {
		body = await request.json<ChatCompletionRequest>();
	} catch {
		return errorResponse(
			"请求正文不是有效的 JSON",
			400,
		);
	}

	if (
		!body ||
		!Array.isArray(body.messages) ||
		body.messages.length === 0
	) {
		return errorResponse(
			"messages 必须是非空数组",
			400,
		);
	}

	/*
	 * 插件 system 消息中的翻译指令会被忽略，避免覆盖 Worker 内部的
	 * 学术翻译规则；其中附带的论文标题和摘要会保留下来作为背景。
	 */
	const paperContext = extractPaperContext(
		body.messages
			.filter((message) => message?.role === "system")
			.map((message) => contentToText(message.content))
			.join("\n"),
	);

	/*
	 * 保留 user 和 assistant 消息。user 消息是从 PDF 中选中的原文，
	 * 先清理连字、断词和段内换行。
	 */
	const inputMessages: ChatMessage[] = body.messages
		.filter(
			(
				message,
			): message is IncomingMessage & {
				role: "user" | "assistant";
			} =>
				message?.role === "user" || message?.role === "assistant",
		)
		.map((message) => {
			const text = contentToText(message.content);

			return {
				role: message.role,
				content:
					message.role === "user"
						? cleanSourceText(text)
						: text.trim(),
			};
		})
		.filter((message) => message.content.length > 0);

	if (inputMessages.length === 0) {
		return errorResponse(
			"没有检测到有效的翻译文本",
			400,
		);
	}

	const lastUserMessage = inputMessages.findLast(
		(message) => message.role === "user",
	);

	if (!lastUserMessage) {
		return errorResponse(
			"messages 中至少需要一条 user 消息",
			400,
		);
	}

	/*
	 * 新版插件只把原文放在 user 消息中；旧版或自定义 Prompt 可能把
	 * 翻译要求和原文一起放入最后一条 user 消息，同样可以用于术语匹配。
	 */
	const sourceText = lastUserMessage.content;

	if (sourceText.length > MAX_SOURCE_LENGTH) {
		return errorResponse(
			"单次翻译文本过长，请分段翻译",
			413,
			"request_too_large",
		);
	}

	const messages: ChatMessage[] = [
		{
			role: "system",
			content: buildSystemPrompt(sourceText, paperContext),
		},
		...inputMessages,
	];

	/*
	 * Zotero 插件默认发送 temperature: 1.0，对翻译来说随机性过高，
	 * 同一段文字每次的译法都可能不同。这里限制在 0.3 以内。
	 */
	const temperature = clampNumber(
		body.temperature,
		0,
		0.3,
		0.2,
	);

	/*
	 * Zotero 插件默认不传 max_tokens。中文译文的 Token 数
	 * 通常和英文原文相近，2048 在翻译整段长文时容易被截断；
	 * 输出按实际用量计费，调高上限不会增加正常请求的消耗。
	 */
	const maxTokens = clampNumber(
		body.max_tokens,
		64,
		8192,
		4096,
	);

	/*
	 * Zotero 插件默认开启 Stream，译文会边生成边显示。
	 */
	const stream = body.stream === true;
	const models = resolveModels(body.model);

	/*
	 * 同一段文字重复翻译时直接返回缓存，不调用模型。
	 * 请求头 Cache-Control: no-cache 或请求体 "cache": false
	 * 会跳过读取缓存，新的译文仍会写入缓存。
	 */
	const cache = env.TRANSLATION_CACHE;
	const bypassCache =
		body.cache === false ||
		/no-cache/i.test(request.headers.get("Cache-Control") ?? "");

	const cacheStatus: CacheStatus = !cache
		? "DISABLED"
		: bypassCache
			? "BYPASS"
			: "MISS";

	const cacheKeyFor = (modelId: string) =>
		buildCacheKey(modelId, temperature, messages);

	if (cacheStatus === "MISS") {
		const modelId = models[0].id;
		const cached = await readCache(cache, await cacheKeyFor(modelId));

		if (cached) {
			const headers = translationHeaders(modelId, "HIT", stream);

			return stream
				? new Response(textToOpenAIStream(cached, modelId), { headers })
				: completionResponse(cached, modelId, "stop", undefined, headers);
		}
	}

	/*
	 * 只缓存完整结束的译文，被 max_tokens 截断的结果不缓存。
	 */
	const saveToCache = (
		modelId: string,
		text: string,
		finishReason: string,
	) => {
		if (cache && text && finishReason === "stop") {
			ctx.waitUntil(
				cacheKeyFor(modelId).then((key) => writeCache(cache, key, text)),
			);
		}
	};

	let run: Awaited<ReturnType<typeof runWithFallback>>;

	try {
		run = await runWithFallback(env.AI, models, {
			messages,
			temperature,
			max_tokens: maxTokens,
			stream,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: String(error);

		return errorResponse(
			message,
			502,
			"workers_ai_error",
		);
	}

	const { model, result } = run;
	const headers = translationHeaders(model.id, cacheStatus, stream);

	if (stream) {
		return new Response(
			toOpenAIStream(
				result as ReadableStream<Uint8Array>,
				model.id,
				(text, finishReason) =>
					saveToCache(model.id, text, finishReason),
			),
			{ headers },
		);
	}

	const data = result as WorkersAIResult;
	const translatedText = stripThinking(
		data.choices?.[0]?.message?.content ??
			data.response ??
			"",
	);

	if (!translatedText) {
		return errorResponse(
			"模型没有返回最终译文",
			502,
			"model_error",
		);
	}

	const finishReason = data.choices?.[0]?.finish_reason ?? "stop";
	saveToCache(model.id, translatedText, finishReason);

	return completionResponse(
		translatedText,
		model.id,
		finishReason,
		data.usage,
		headers,
	);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;

		/*
		 * 健康检查接口，不调用模型，也不消耗 Workers AI 额度。
		 */
		if (route === "GET /health") {
			return Response.json({
				status: "ok",
				service: "zotero-academic-translator",
				models: MODELS.map(({ name, id, description }) => ({
					name,
					id,
					description,
				})),
				cache: Boolean(env.TRANSLATION_CACHE),
			});
		}

		/*
		 * 仅提供 OpenAI 兼容的聊天补全和模型列表接口。
		 */
		if (
			route !== "POST /v1/chat/completions" &&
			route !== "GET /v1/models"
		) {
			return errorResponse(
				"请使用 POST /v1/chat/completions",
				404,
				"not_found_error",
			);
		}

		/*
		 * 验证 Zotero 插件发送的访问密钥。
		 *
		 * 未配置密钥时直接拒绝，否则 "Bearer undefined"
		 * 会被当成合法密钥放行。
		 */
		if (!env.ZOTERO_API_KEY) {
			return errorResponse(
				"服务端未配置 ZOTERO_API_KEY，请先运行 wrangler secret put ZOTERO_API_KEY",
				500,
				"server_error",
			);
		}

		const authorization = request.headers.get("Authorization") ?? "";

		if (!(await safeEqual(authorization, `Bearer ${env.ZOTERO_API_KEY}`))) {
			return errorResponse(
				"API 密钥无效",
				401,
				"authentication_error",
			);
		}

		if (route === "GET /v1/models") {
			return Response.json({
				object: "list",
				data: MODELS.map((model) => ({
					id: model.name,
					object: "model",
					created: 0,
					owned_by: "workers-ai",
				})),
			});
		}

		return handleChatCompletion(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
