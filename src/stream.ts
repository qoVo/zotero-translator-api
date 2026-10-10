const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * 过滤译文开头的 <think>...</think> 推理块和多余空白。
 *
 * 即使追加了 /no_think，Qwen3 仍可能先输出一个空的
 * <think>\n\n</think>\n\n。流式输出时标签可能被拆到多个分片里，
 * 所以这里按状态逐段处理：只缓存开头可能属于标签的部分，
 * 一旦确认进入正文，后续内容直接透传。
 */
export function createThinkFilter() {
	let state: "start" | "thinking" | "output" = "start";
	let pending = "";

	return {
		push(text: string): string {
			if (state === "output") {
				return text;
			}

			pending += text;

			for (;;) {
				if (state === "thinking") {
					const end = pending.indexOf(THINK_CLOSE);

					if (end < 0) {
						return "";
					}

					pending = pending.slice(end + THINK_CLOSE.length);
					state = "start";
					continue;
				}

				pending = pending.trimStart();

				if (pending.startsWith(THINK_OPEN)) {
					pending = pending.slice(THINK_OPEN.length);
					state = "thinking";
					continue;
				}

				/*
				 * 还无法判断是不是 <think> 的开头，继续等待下一个分片。
				 */
				if (THINK_OPEN.startsWith(pending)) {
					return "";
				}

				state = "output";
				const output = pending;
				pending = "";
				return output;
			}
		},

		/**
		 * 输出结束时调用。没有闭合的推理块会被丢弃。
		 */
		flush(): string {
			const output = state === "thinking" ? "" : pending;
			pending = "";
			return output;
		},
	};
}

export function stripThinking(text: string): string {
	const filter = createThinkFilter();
	return (filter.push(text) + filter.flush()).trim();
}

interface UpstreamEvent {
	response?: string | null;
	choices?: Array<{
		delta?: { content?: string | null };
		finish_reason?: string | null;
	}>;
	usage?: unknown;
}

/**
 * Zotero 翻译插件按 "data:" 直接切分 SSE 文本，
 * 如果译文里恰好出现 "data:"，JSON 会被切断。
 * 把冒号写成 JSON 转义 \u003a，解析结果不变。
 */
function encodeEvent(payload: unknown): string {
	const json = JSON.stringify(payload).replaceAll("data:", "data\\u003a");
	return `data: ${json}\n\n`;
}

const encoder = new TextEncoder();

/**
 * 生成同一次回复的 OpenAI chat.completion.chunk 分片。
 */
function createChunkEncoder(model: string) {
	const id = `chatcmpl-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);

	return {
		chunk(
			delta: { role?: string; content?: string },
			finish_reason: string | null = null,
			usage?: unknown,
		): Uint8Array {
			return encoder.encode(
				encodeEvent({
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta, finish_reason }],
					...(usage ? { usage } : {}),
				}),
			);
		},

		done(): Uint8Array {
			return encoder.encode("data: [DONE]\n\n");
		},
	};
}

/**
 * 把 Workers AI 的流式输出转换成 OpenAI chat.completion.chunk 格式。
 *
 * 不同模型的分片格式不完全一致，这里同时兼容
 * {"response": "..."} 和 {"choices": [{"delta": {"content": "..."}}]}。
 *
 * 流正常结束后调用 onComplete，传入完整译文和结束原因，用于写入缓存。
 * 客户端中途断开时不会调用。
 */
export function toOpenAIStream(
	upstream: ReadableStream<Uint8Array>,
	model: string,
	onComplete?: (text: string, finishReason: string) => void,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const chunks = createChunkEncoder(model);
	const thinkFilter = createThinkFilter();

	let lineBuffer = "";
	let output = "";
	let finishReason: string | null = null;
	let usage: unknown;

	const emit = (
		content: string,
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		if (content) {
			output += content;
			controller.enqueue(chunks.chunk({ content }));
		}
	};

	const handleLine = (
		line: string,
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		const trimmed = line.trim();

		if (!trimmed.startsWith("data:")) {
			return;
		}

		const data = trimmed.slice(5).trim();

		if (!data || data === "[DONE]") {
			return;
		}

		let event: UpstreamEvent;

		try {
			event = JSON.parse(data);
		} catch {
			return;
		}

		const choice = event.choices?.[0];
		finishReason = choice?.finish_reason ?? finishReason;
		usage = event.usage ?? usage;

		emit(
			thinkFilter.push(choice?.delta?.content ?? event.response ?? ""),
			controller,
		);
	};

	return upstream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start(controller) {
				controller.enqueue(chunks.chunk({ role: "assistant", content: "" }));
			},

			transform(data, controller) {
				lineBuffer += decoder.decode(data, { stream: true });

				const lines = lineBuffer.split("\n");
				lineBuffer = lines.pop() ?? "";

				for (const line of lines) {
					handleLine(line, controller);
				}
			},

			flush(controller) {
				lineBuffer += decoder.decode();
				handleLine(lineBuffer, controller);
				emit(thinkFilter.flush(), controller);

				const reason = finishReason ?? "stop";
				controller.enqueue(chunks.chunk({}, reason, usage));
				controller.enqueue(chunks.done());
				onComplete?.(output.trim(), reason);
			},
		}),
	);
}

/**
 * 把一段完整译文（例如缓存命中的结果）按流式格式返回。
 */
export function textToOpenAIStream(
	text: string,
	model: string,
): ReadableStream<Uint8Array> {
	const chunks = createChunkEncoder(model);

	return new ReadableStream({
		start(controller) {
			controller.enqueue(chunks.chunk({ role: "assistant", content: "" }));
			controller.enqueue(chunks.chunk({ content: text }));
			controller.enqueue(chunks.chunk({}, "stop"));
			controller.enqueue(chunks.done());
			controller.close();
		},
	});
}
