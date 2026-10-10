/**
 * 这里只收录需要强制统一、容易产生歧义或模型经常翻错的术语。
 *
 * 没有收录的术语仍然会由模型根据上下文正常翻译。
 * 当前选中文本没有出现的术语不会被加入提示词。
 */
export const CORE_GLOSSARY: Record<string, string> = {
	// 跟踪任务
	"single object tracking": "单目标跟踪",
	"visual object tracking": "视觉目标跟踪",
	"multiple object tracking": "多目标跟踪",
	"long-term tracking": "长时跟踪",

	// 跟踪框架
	"one-stream": "单流",
	"two-stream": "双流",
	"siamese network": "孪生网络",
	"siamese": "孪生",

	// 模板与搜索区域
	"search region": "搜索区域",
	"search image": "搜索图像",
	"search frame": "搜索帧",
	"template image": "模板图像",
	"template frame": "模板帧",
	"template branch": "模板分支",
	"search branch": "搜索分支",
	"initial template": "初始模板",
	"dynamic template": "动态模板",
	"template update": "模板更新",

	// 目标与干扰
	"target appearance": "目标外观",
	"appearance variation": "外观变化",
	"appearance model": "外观模型",
	"similar distractor": "相似干扰物",
	"background distractor": "背景干扰物",
	"distractor": "干扰物",
	"target loss": "目标丢失",
	"tracking failure": "跟踪失败",
	"tracking drift": "跟踪漂移",

	// 困难场景
	"partial occlusion": "部分遮挡",
	"full occlusion": "完全遮挡",
	"occlusion": "遮挡",
	"deformation": "形变",
	"scale variation": "尺度变化",
	"illumination variation": "光照变化",
	"viewpoint variation": "视角变化",
	"fast motion": "快速运动",
	"motion blur": "运动模糊",
	"out of view": "移出视野",
	"background clutter": "背景杂乱",
	"low resolution": "低分辨率",

	// 边界框与预测
	"bounding box": "边界框",
	"bounding box regression": "边界框回归",
	"predicted box": "预测框",
	"ground-truth box": "真实框",
	"ground truth": "真实标注",
	"classification score": "分类分数",
	"confidence score": "置信度分数",
	"response map": "响应图",
	"score map": "得分图",
	"probability map": "概率图",
	"center prediction": "中心预测",
	"offset prediction": "偏移预测",

	// 特征处理
	"feature extraction": "特征提取",
	"feature aggregation": "特征聚合",
	"feature interaction": "特征交互",
	"feature fusion": "特征融合",
	"feature representation": "特征表示",
	"multi-scale feature": "多尺度特征",
	"deep feature": "深层特征",
	"shallow feature": "浅层特征",
	"spatial feature": "空间特征",
	"temporal feature": "时序特征",

	// Transformer
	"self-attention": "自注意力",
	"self attention": "自注意力",
	"cross-attention": "交叉注意力",
	"cross attention": "交叉注意力",
	"attention mechanism": "注意力机制",
	"attention map": "注意力图",
	"attention weight": "注意力权重",
	"query token": "查询 Token",
	"template token": "模板 Token",
	"search token": "搜索 Token",
	"target token": "目标 Token",
	"token pruning": "Token 剪枝",
	"token selection": "Token 选择",
	"token merging": "Token 合并",
	"candidate elimination": "候选消除",
	"positional encoding": "位置编码",
	"position embedding": "位置嵌入",

	// 时序与运动
	"temporal information": "时序信息",
	"temporal modeling": "时序建模",
	"temporal prior": "时序先验",
	"temporal consistency": "时序一致性",
	"motion information": "运动信息",
	"motion modeling": "运动建模",
	"motion prediction": "运动预测",
	"motion prior": "运动先验",
	"trajectory prediction": "轨迹预测",
	"historical trajectory": "历史轨迹",
	"previous frame": "上一帧",
	"current frame": "当前帧",

	// 记忆与更新
	"online update": "在线更新",
	"model update": "模型更新",
	"memory update": "记忆更新",
	"long-term memory": "长期记忆",
	"short-term memory": "短期记忆",
	"memory bank": "记忆库",
	"memory module": "记忆模块",
	"historical information": "历史信息",
	"historical feature": "历史特征",

	// 训练
	"training sample": "训练样本",
	"positive sample": "正样本",
	"negative sample": "负样本",
	"hard negative sample": "困难负样本",
	"data augmentation": "数据增强",
	"pre-trained model": "预训练模型",
	"pre-training": "预训练",
	"fine-tuning": "微调",
	"end-to-end training": "端到端训练",
	"training objective": "训练目标",
	"loss function": "损失函数",

	// 常用评价指标
	"success rate": "成功率",
	"success plot": "成功率曲线",
	"precision plot": "精确率曲线",
	"average overlap": "平均重叠率",
	"intersection over union": "交并比",
};

interface GlossaryMatcher {
	english: string;
	chinese: string;
	pattern: RegExp;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把术语编译成正则：
 *
 * - 按完整单词匹配，避免短术语误命中其他单词的一部分；
 * - 连字符和空格可以互换，也可以省略，例如
 *   self-attention / self attention、pre-trained / pretrained；
 * - 允许英文复数，例如 bounding boxes、positive samples。
 */
function compileTerm(english: string): RegExp {
	const body = english
		.toLowerCase()
		.split(/[\s-]+/)
		.map(escapeRegExp)
		.join("[\\s-]?");

	return new RegExp(`\\b${body}(?:e?s)?\\b`, "i");
}

/**
 * 在模块加载时编译一次，之后每个请求直接复用。
 *
 * 只是连字符或空格不同的重复写法（例如 self-attention 和
 * self attention）只保留第一条，避免提示词中出现重复术语。
 * 较长术语排在前面，例如 similar distractor 优先于 distractor。
 */
const GLOSSARY_MATCHERS: GlossaryMatcher[] = (() => {
	const seen = new Set<string>();
	const matchers: GlossaryMatcher[] = [];

	for (const [english, chinese] of Object.entries(CORE_GLOSSARY)) {
		const key = english.toLowerCase().replace(/[\s-]+/g, "");

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		matchers.push({ english, chinese, pattern: compileTerm(english) });
	}

	return matchers.sort((a, b) => b.english.length - a.english.length);
})();

/**
 * 仅提取当前文本中实际出现的术语。
 */
export function buildGlossaryPrompt(sourceText: string): string {
	const matchedTerms = GLOSSARY_MATCHERS.filter(({ pattern }) =>
		pattern.test(sourceText),
	);

	if (matchedTerms.length === 0) {
		return "";
	}

	return [
		"",
		"当前文本涉及以下术语，请优先采用指定译法：",
		...matchedTerms.map(
			({ english, chinese }) => `${english} → ${chinese}`,
		),
	].join("\n");
}
