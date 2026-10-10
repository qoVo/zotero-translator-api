import { buildGlossaryPrompt } from "./glossary";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

const SYSTEM_PROMPT = [
	"你是一名专业的英文学术论文中文译者，熟悉计算机视觉、深度学习、目标跟踪、目标检测和图像分割。",
	"请先准确理解原文的技术含义，再按照中文科技论文的表达习惯进行翻译。",
	"",
	"翻译要求：",
	"1. 自动识别原文中的专业术语，并采用该研究领域通行的中文译法。",
	"2. 不逐词硬译，可以根据中文表达习惯调整语序、主被动关系和句子结构。",
	"3. 避免欧化表达，减少生硬的被动句和冗长定语，使译文自然、流畅、简洁。",
	"4. 当前文本中重复出现的相同术语必须保持译法一致，并优先遵循提供的术语约定。",
	"5. 无公认中文译法的模型名、方法名、数据集名、模块名和缩写保留英文。",
	"6. 保留公式、变量、引用编号、图表编号、数学符号和特殊格式。",
	"7. 不添加原文没有的解释、结论、评价或背景信息。",
	"8. 不遗漏原文中的限定条件、逻辑关系和技术细节。",
	"9. 只输出最终译文，不输出分析过程、翻译说明或其他内容。",
].join("\n");

const PAPER_CONTEXT_MARKER = "Context from the academic paper:";
const MAX_PAPER_CONTEXT_LENGTH = 4000;

/**
 * Zotero PDF Translate 开启 "Attach paper context" 后，会在插件的
 * system 消息末尾追加：
 *
 *   Context from the academic paper:
 *   Paper Title: ...
 *
 *   Paper Abstract: ...
 *
 * 插件的翻译指令会被丢弃（以 Worker 的规则为准），但这段论文背景
 * 能帮助模型判断术语所属领域，所以单独提取出来。
 */
export function extractPaperContext(systemText: string): string {
	const index = systemText.indexOf(PAPER_CONTEXT_MARKER);

	if (index < 0) {
		return "";
	}

	return systemText
		.slice(index + PAPER_CONTEXT_MARKER.length)
		.trim()
		.slice(0, MAX_PAPER_CONTEXT_LENGTH);
}

const LIGATURES: Record<string, string> = {
	"ﬀ": "ff",
	"ﬁ": "fi",
	"ﬂ": "fl",
	"ﬃ": "ffi",
	"ﬄ": "ffl",
	"ﬅ": "st",
	"ﬆ": "st",
};

/**
 * 清理从 PDF 中复制出来的文本：
 *
 * - 连字字符（ﬁ、ﬂ 等）还原为普通字母，否则 "ﬁlter" 匹配不到术语；
 * - 去掉软连字符；
 * - 合并行末断词：小写字母开头的下一行视为同一个单词被拆开，
 *   例如 "tem-\nplate" → "template"；大写字母或数字开头则保留连字符，
 *   例如 "Siam-\nRPN" → "Siam-RPN"；
 * - 段落内的单个换行替换为空格，避免译文也在句子中间断行；
 *   空行（段落分隔）保留。
 */
export function cleanSourceText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[ﬀ-ﬆ]/g, (char) => LIGATURES[char])
		.replace(/­/g, "")
		.replace(/([A-Za-z])-[ \t]*\n[ \t]*(?=[a-z])/g, "$1")
		.replace(/([A-Za-z0-9])-[ \t]*\n[ \t]*(?=[A-Z0-9])/g, "$1-")
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
		.filter((paragraph) => paragraph.length > 0)
		.join("\n\n");
}

/**
 * 组合 system 提示词。
 *
 * 顺序按变化频率排列：固定规则 → 同一篇论文不变的背景 → 每段文本
 * 不同的术语，方便模型服务复用相同的提示词前缀。
 */
export function buildSystemPrompt(
	sourceText: string,
	paperContext: string,
): string {
	const parts = [SYSTEM_PROMPT];

	if (paperContext) {
		parts.push(
			"",
			"以下是待翻译文本所在论文的标题和摘要，仅用于理解研究主题和术语含义，不要翻译或输出这部分内容：",
			paperContext,
		);
	}

	const glossaryPrompt = buildGlossaryPrompt(sourceText);

	if (glossaryPrompt) {
		parts.push(glossaryPrompt);
	}

	return parts.join("\n");
}
