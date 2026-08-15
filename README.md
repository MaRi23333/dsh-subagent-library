# dsh-plugin-subagent-library

DeepSeek Harness 的具名子代理库插件：在 `settings.yaml` 里维护一份"角色子代理"清单（模型 + persona + 工具过滤），所有会话（任意 agent preset）都能通过两个模型可见工具使用它：

- `list_subagents` — 列出库内条目（id / 角色描述 / 模型），模型据此挑选合适条目；
- `delegate` — 按 `library_id` 派活：前台等待、后台 one-shot 任务、或 continuable 可续聊子代理（按条目配置）。

另有 `/subagent` 命令在命令面板里列出库内容。

## 配置

`$DSH_HOME/settings.yaml`（热生效，无需重启）：

```yaml
subagent-library:
  entries:
    k3-reviewer:
      description: Kimi K3-256K 独立只读审核，支持图片视觉走查
      provider: kimi-coding
      model: k3-256k
      persona: |
        你是运行在 Kimi K3-256K 上的独立审核 agent……
      toolFilter:
        deny: [write, edit, todo_write, create_goal, update_goal, subagent, subagent_fork, send_message, interrupt_agent, workflow, ralph]
      maxDepth: 1
      backgroundMode: continuable
```

条目字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id`（dict 键） | 是 | `[a-z0-9][a-z0-9-]*`，如 `k3-reviewer` |
| `description` | 是 | 角色描述，`list_subagents` 展示给模型 |
| `provider` | 否 | **LLM 路由**（如 `deepseek-official`、`kimi-coding`）；缺省用调用方默认 |
| `model` | 否 | LLM 模型 id；缺省用调用方的会话默认模型 |
| `subagentProvider` | 否 | **子代理传输层**（`spawn` 等 `ctx.subagents` provider）；默认取插件级默认 `spawn` |
| `maxTokens` | 否 | 子代理输出上限 |
| `persona` | 否 | 子代理角色提示词 |
| `toolFilter` | 否 | `allow`/`deny` 工具名单（只读角色用 deny 禁写类工具） |
| `maxDepth` | 否 | 委派深度上限；**无默认**——缺省完全交给 harness 全局深度语义（不误伤不支持 depthLimit 的传输层） |
| `backgroundMode` | 否 | `one-shot`（默认）/ `continuable`（可续聊） |

> 注意区分两个 provider 概念：`provider` 指 LLM 路由（`agentOptions.provider`），
> `subagentProvider` 指子代理传输层（`ctx.subagents` 注册名，如 `spawn`/`fork`/`acp`）。

## 安装

```sh
# 从 GitHub 安装（git-hosted 插件会在安装时构建）
dsh plugin --profile web add github:<your-name>/dsh-plugin-subagent-library

# 或从本地目录安装
git clone https://github.com/<your-name>/dsh-plugin-subagent-library.git
cd dsh-plugin-subagent-library
pnpm install && pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-plugin-subagent-library
```

然后**重启 dsh web**（关掉终端重新运行 `dsh web`）并刷新页面。

> 仓库已提交 `lib/` 构建产物，git 安装无需本地构建；改源码后运行 `pnpm run build` 再重启即可。
> 库内条目的增删改（`$DSH_HOME/settings.yaml`）**热生效**，无需重启。

## 设置页

Settings → 设置 里新增「子代理库」卡片：可视化增删改条目（描述 / Provider / 模型 /
禁用工具 / 深度 / 后台模式 / 角色提示词），写回 `$DSH_HOME/settings.yaml`，热生效。

## 设计说明

- 工具注册在 **host 平面**：不依赖任何 agent preset，切 preset 不会丢；
- 派发走标准 `ctx.subagents` 缝（spawn 等 provider），子代理沿用 harness 语义：审批固定 never、沙箱继承父会话、深度上限、continuable 支持；
- 条目解析每次操作实时读取 settings，热编辑立即生效。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build   # host: lib/index.js；client: lib/client.js
```

- 依赖 DSH `0.1.0-rc.6` 的运行时 API；其他版本如接口漂移请对照 [deepseek-harness 仓库](https://github.com/deepseek-ai/deepseek-harness) 相应 tag 调整。

## License

[MIT](./LICENSE)
