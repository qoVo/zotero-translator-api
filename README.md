# Zotero 学术翻译 API

部署在 Cloudflare Workers 上的 OpenAI 兼容翻译接口，配合 Zotero 插件 [PDF Translate](https://github.com/windingwind/zotero-pdf-translate) 使用。模型由 Workers AI 提供，Worker 负责把通用的大模型调成"英文论文 → 中文"的专用译者：

- **统一的翻译规则**：忽略插件自带的 Prompt，使用 Worker 内置的学术翻译要求
- **术语表**：只把原文中实际出现的术语（目标跟踪、Transformer 等方向）加入提示词，保证译法统一
- **论文背景**：插件开启附带论文信息后，标题和摘要会作为背景交给模型，帮助判断术语含义
- **PDF 文本清理**：修复连字（ﬁ、ﬂ）、行末断词和句中换行
- **流式输出**：译文边生成边显示
- **译文缓存**：同一段文字再次翻译时直接返回，不消耗模型额度
- **多模型与自动备用**：可以在 Zotero 中切换模型；一个模型调用失败时自动换另一个

## 部署

```bash
npm install
npx wrangler login

# 设置访问密钥，Zotero 中填写同一个值
npx wrangler secret put ZOTERO_API_KEY

npm run deploy
```

首次部署时 Wrangler 会自动创建译文缓存用的 KV 命名空间，并把它的 ID 写进 `wrangler.jsonc`。这个 ID 只对你自己的账户有效，不需要提交：不写 ID 时，之后的部署会沿用已部署 Worker 上的同一个命名空间。

部署完成后访问 `https://<你的 Worker 域名>/health`，返回 `"status": "ok"` 即可。

`*.workers.dev` 地址在中国大陆经常无法访问，也有账户遇到过所有 workers.dev 地址都返回 1101 错误的情况。这时可以在 Cloudflare 控制台的 Worker 设置 → 域和路由中添加自定义域名，Zotero 中改填这个域名。在控制台添加的域名不会被 `wrangler deploy` 移除。

## 在 Zotero 中配置

在 PDF Translate 的设置中选择 **自定义GPT1**（或 2、3），然后填写：

| 设置 | 填写内容 |
| --- | --- |
| 接口 | `https://<你的 Worker 域名>/v1/chat/completions` |
| 密钥 | 与 `ZOTERO_API_KEY` 相同 |
| 模型 | `gemma`、`qwen3` 或 `glm`，留空时使用 `gemma` |
| 流式输出 | 开启 |
| 温度 | 不需要修改，Worker 会把温度限制在 0.3 以内 |

建议同时勾选 **向GPT/Claude/Gemini服务提供论文标题和摘要**。

插件里的 Prompt 不会生效，翻译规则以 `src/prompt.ts` 为准。

## 模型

| 名称 | Workers AI 模型 | 说明 |
| --- | --- | --- |
| `gemma` | `@cf/google/gemma-4-26b-a4b-it` | 默认模型，实测译文最贴合原意 |
| `qwen3` | `@cf/qwen/qwen3-30b-a3b-fp8` | 速度快、价格最低 |
| `glm` | `@cf/zai-org/glm-4.7-flash` | 智谱 GLM-4.7-Flash |

三个模型都能在 Workers 免费计划上使用，翻译一段话约 1～2 秒，价格相近。2026-10 用三段目标跟踪论文实测：gemma 没有出现语义错误；qwen3 把 "one-stream" 译成了"一流"（该术语随后已加入术语表）；glm 有一句颠倒了因果关系。

请求的模型调用失败时（例如容量不足），Worker 会依次改用其余模型。实际使用的模型可以在响应头 `X-Translation-Model` 中看到，失败记录在 Cloudflare 控制台的 Workers 日志中。

新增模型时在 `src/models.ts` 的 `MODELS` 中添加一项。这些模型默认都会先推理再作答（一句话可能要等 30 秒），必须关闭推理模式，并实际调用一次确认译文在 `content` 中。付费计划还可以加入 `@cf/deepseek-ai/deepseek-v4-flash-0731`（免费计划调用会返回 5035 错误）。

## 译文缓存

译文按"模型 + 温度 + 完整提示词（含原文、术语和论文背景）"缓存 30 天。修改提示词或术语表后，旧缓存自然不会再命中。被 `max_tokens` 截断的译文不会缓存。

对缓存的译文不满意时，可以：

- 换一个模型翻译，不同模型的缓存互相独立
- 在插件的 **自定义请求** 中添加 `{"cache": false}`，之后每次都重新翻译（新译文仍会写入缓存）

KV 会把"未找到"的结果在边缘节点缓存约 60 秒，所以第一次翻译后要过一分钟左右，同一段文字才会命中缓存。

响应头 `X-Translation-Cache` 表示缓存状态：`HIT`、`MISS`、`BYPASS`（跳过读取）或 `DISABLED`（没有绑定 KV）。

KV 免费额度为每天 1000 次写入，超出后只是不再写缓存，翻译不受影响。

## 自定义

| 想修改的内容 | 位置 |
| --- | --- |
| 翻译规则 | `src/prompt.ts` 中的 `SYSTEM_PROMPT` |
| 术语表 | `src/glossary.ts` 中的 `CORE_GLOSSARY` |
| 可选模型 | `src/models.ts` 中的 `MODELS` |

术语匹配不区分大小写，连字符和空格可以互换，也能匹配复数，例如 `self-attention` 能匹配 `self attention`，`bounding box` 能匹配 `bounding boxes`。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /health` | 健康检查，不需要密钥 |
| `GET /v1/models` | 可选模型列表 |
| `POST /v1/chat/completions` | 翻译，兼容 OpenAI Chat Completions 格式 |

## 开发

```bash
npm test          # 运行测试，使用模拟的模型，不消耗额度
npx tsc --noEmit  # 类型检查
```

本地运行 `npm run dev` 前，先在 `.dev.vars` 中写入 `ZOTERO_API_KEY=任意值`。Workers AI 只能远程调用，本地调试同样需要登录并会消耗额度。

修改 `wrangler.jsonc` 中的绑定后，运行 `npm run cf-typegen` 重新生成类型。

## 许可证

[MIT](LICENSE)
