import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/*
 * 测试时不读取 wrangler.jsonc：AI 绑定只能连接远程 Workers AI，
 * 会消耗额度并要求登录。测试中使用本地 KV，AI 绑定用模拟对象代替。
 */
export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: "2026-08-06",
					compatibilityFlags: ["nodejs_compat"],
					kvNamespaces: ["TRANSLATION_CACHE"],
				},
			},
		},
	},
});
