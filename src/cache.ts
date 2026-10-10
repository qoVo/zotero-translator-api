import type { ChatMessage } from "./prompt";

/*
 * 修改缓存内容的格式时递增版本号，旧缓存会自然失效。
 * 提示词、术语表或论文背景变化时，缓存键本身就会变化，不需要改这里。
 */
const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type CacheStatus = "HIT" | "MISS" | "BYPASS" | "DISABLED";

/**
 * 缓存键由模型、温度和发送给模型的完整消息（含 system 提示词）决定。
 * KV 键名最长 512 字节，所以使用 SHA-256 摘要。
 */
export async function buildCacheKey(
	modelId: string,
	temperature: number,
	messages: ChatMessage[],
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([CACHE_VERSION, modelId, temperature, messages]),
		),
	);

	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

	return `translation:${hex}`;
}

/**
 * 缓存出错时当作未命中处理，不影响翻译。
 */
export async function readCache(
	kv: KVNamespace,
	key: string,
): Promise<string | null> {
	try {
		return await kv.get(key);
	} catch (error) {
		console.error("读取译文缓存失败", error);
		return null;
	}
}

/**
 * KV 免费额度每天 1000 次写入，超出后写入失败也只记录日志。
 */
export async function writeCache(
	kv: KVNamespace,
	key: string,
	text: string,
): Promise<void> {
	try {
		await kv.put(key, text, { expirationTtl: CACHE_TTL_SECONDS });
	} catch (error) {
		console.error("写入译文缓存失败", error);
	}
}
