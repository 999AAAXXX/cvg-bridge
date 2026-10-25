# Changelog

## v1.0.0

首个公开版本。

- OpenAI 兼容 `/v1/chat/completions`（流式 + tool_calls）
- Anthropic 原生 `/v1/messages`（cache_control 断点）
- 多账号池：按 sub 去重、账号级模型白名单、401/402 自动切号重试
- 全模型缓存策略：prompt_cache_key / cache_control / implicit-prefix
- 流式平滑输出（4 字 / 22ms 可调）
- 单页控制台：对话、模型矩阵、用量与花费、缓存策略、账号池管理
- 用量台账：prompt / cached / completion / 估算 credits，持久化
- cookie 注入续期脚本（--headed 过 Cloudflare）
