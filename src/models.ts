import type { ChatMessage } from "./prompt";

export interface ModelInputs {
	messages: ChatMessage[];
	temperature: number;
	max_tokens: number;
	stream: boolean;
	[key: string]: unknown;
}

export interface ModelProfile {
	/** 在 Zotero 插件的 Model 一栏填写的名称 */
	name: string;
	/** Workers AI 模型 ID，也可以直接填在 Model 一栏 */
	id: string;
	description: string;
	/** 按模型要求关闭推理模式 */
	prepare(inputs: ModelInputs): ModelInputs;
}

/**
 * 可选模型。第一个是默认模型：Model 一栏留空或填写了
 * 不认识的名称（例如 gpt-4o-mini）时使用。
 *
 * 以下模型都已在 Workers 免费计划上实测可用（2026-10）。
 * 这几个模型默认都会先推理再作答，一句话的翻译可能要等 30 秒，
 * 所以必须关闭推理模式。新增模型时，先实际调用一次，确认关闭推理后
 * 译文仍在 choices[0].message.content 中。
 *
 * 付费计划还可以使用 @cf/deepseek-ai/deepseek-v4-flash-0731，
 * 关闭推理的方式是 reasoning_effort: "none"。
 */
export const MODELS: ModelProfile[] = [
	{
		name: "gemma",
		id: "@cf/google/gemma-4-26b-a4b-it",
		description: "默认模型，Google Gemma 4，实测译文最贴合原意",
		prepare: disableThinkingByTemplate,
	},
	{
		name: "qwen3",
		id: "@cf/qwen/qwen3-30b-a3b-fp8",
		description: "通义千问 Qwen3，速度快、价格最低",
		/*
		 * Qwen3 默认可能输出较长推理过程。
		 * /no_think 用于关闭推理模式，减少延迟和 Token 消耗。
		 *
		 * 不能用 chat_template_kwargs.enable_thinking: false：
		 * Workers AI 会把整段译文放进 reasoning_content，content 为空。
		 */
		prepare(inputs) {
			const messages = inputs.messages.map((message) => ({ ...message }));
			const lastUser = messages.findLast(
				(message) => message.role === "user",
			);

			if (lastUser && !lastUser.content.includes("/no_think")) {
				lastUser.content += "\n/no_think";
			}

			return { ...inputs, messages };
		},
	},
	{
		name: "glm",
		id: "@cf/zai-org/glm-4.7-flash",
		description: "智谱 GLM-4.7-Flash，价格与 qwen3 相近",
		prepare: disableThinkingByTemplate,
	},
];

function disableThinkingByTemplate(inputs: ModelInputs): ModelInputs {
	return {
		...inputs,
		chat_template_kwargs: { enable_thinking: false },
	};
}

/**
 * 返回按尝试顺序排列的模型：先是请求的模型，其余模型作为备用。
 */
export function resolveModels(requested: unknown): ModelProfile[] {
	const name = typeof requested === "string" ? requested.trim().toLowerCase() : "";
	const selected =
		MODELS.find(
			(model) => model.name === name || model.id.toLowerCase() === name,
		) ?? MODELS[0];

	return [selected, ...MODELS.filter((model) => model !== selected)];
}

/*
 * env.AI.run 的类型按模型 ID 重载，这里的模型 ID 是运行时决定的。
 */
interface AiRunner {
	run(model: string, inputs: ModelInputs): Promise<unknown>;
}

/**
 * 依次尝试模型，直到有一个调用成功。
 *
 * Workers AI 偶尔会返回容量不足等临时错误，换一个模型通常就能成功。
 * 流式输出只在开始前切换模型，已经开始输出的流不会再重试。
 */
export async function runWithFallback(
	ai: Ai,
	models: ModelProfile[],
	inputs: ModelInputs,
): Promise<{ model: ModelProfile; result: unknown }> {
	let lastError: unknown;

	for (const model of models) {
		try {
			const result = await (ai as unknown as AiRunner).run(
				model.id,
				model.prepare(inputs),
			);

			return { model, result };
		} catch (error) {
			lastError = error;

			/*
			 * wrangler.jsonc 已开启 observability，
			 * 可以在 Cloudflare 控制台的 Workers 日志中查看。
			 */
			console.error(`Workers AI 调用失败：${model.id}`, error);
		}
	}

	throw lastError;
}
