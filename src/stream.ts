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
 * 上游中途出错时追加到译文末尾的提示，让用户知道译文不完整。
 */
export const STREAM_INTERRUPTED_NOTICE = "\n\n[翻译中断，请重试]";

/**
 * 把 Workers AI 的流式输出转换成 OpenAI chat.completion.chunk 格式。
 *
 * 不同模型的分片格式不完全一致，这里同时兼容
 * {"response": "..."} 和 {"choices": [{"delta": {"content": "..."}}]}。
 *
 * 流结束后调用 onComplete，传入完整译文和结束原因，用于写入缓存：
 * - 上游给出 finish_reason 时直接使用；
 * - 只收到 [DONE] 时视为正常结束（"stop"）；
 * - 两者都没有就关闭了连接，说明输出可能被截断，传入 "incomplete"。
 *
 * 上游读取出错时，先补发中断提示和结束分片，让插件能正常收尾，
 * 不调用 onComplete，避免缓存不完整的译文。客户端中途断开时也不会调用。
 */
export function toOpenAIStream(
	upstream: ReadableStream<Uint8Array>,
	model: string,
	onComplete?: (text: string, finishReason: string) => void,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const chunks = createChunkEncoder(model);
	const thinkFilter = createThinkFilter();

	let lineBuffer = "";
	let output = "";
	let finishReason: string | null = null;
	let sawDone = false;
	let usage: unknown;
	let emitted = 0;

	type Controller = ReadableStreamDefaultController<Uint8Array>;

	const emit = (content: string, controller: Controller) => {
		if (content) {
			output += content;
			emitted++;
			controller.enqueue(chunks.chunk({ content }));
		}
	};

	const handleLine = (line: string, controller: Controller) => {
		const trimmed = line.trim();

		if (!trimmed.startsWith("data:")) {
			return;
		}

		const data = trimmed.slice(5).trim();

		if (data === "[DONE]") {
			sawDone = true;
			return;
		}

		if (!data) {
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

	/**
	 * 发送结束分片和 [DONE]。插件只认 finish_reason 是否为空，
	 * 所以发给插件的结束原因保持兼容，真实原因单独返回给调用方。
	 */
	const finish = (controller: Controller, clientReason: string) => {
		controller.enqueue(chunks.chunk({}, clientReason, usage));
		controller.enqueue(chunks.done());
		controller.close();
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunks.chunk({ role: "assistant", content: "" }));
		},

		/*
		 * 有的上游分片不产生任何输出（例如推理块、只有 finish_reason
		 * 的分片或 [DONE]）。workerd 在 pull 没有入队内容时不会再次调用
		 * pull，所以这里一直读到有输出或流结束为止。
		 */
		async pull(controller) {
			const emittedBefore = emitted;

			while (emitted === emittedBefore) {
				let result: ReadableStreamReadResult<Uint8Array>;

				try {
					result = await reader.read();
				} catch (error) {
					console.error(`Workers AI 流式输出中断：${model}`, error);

					// 未读完的半行 JSON 直接丢弃，已缓存的正文照常发出。
					emit(thinkFilter.flush(), controller);
					controller.enqueue(
						chunks.chunk({ content: STREAM_INTERRUPTED_NOTICE }),
					);
					finish(controller, "error");
					return;
				}

				if (result.done) {
					lineBuffer += decoder.decode();
					handleLine(lineBuffer, controller);
					emit(thinkFilter.flush(), controller);

					const completedReason =
						finishReason ?? (sawDone ? "stop" : "incomplete");

					onComplete?.(output.trim(), completedReason);
					finish(controller, finishReason ?? "stop");
					return;
				}

				lineBuffer += decoder.decode(result.value, { stream: true });

				const lines = lineBuffer.split("\n");
				lineBuffer = lines.pop() ?? "";

				for (const line of lines) {
					handleLine(line, controller);
				}
			}
		},

		cancel(reason) {
			return reader.cancel(reason);
		},
	});
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
