# dsh-subagent-library

**中文 | [English](./README.en.md)**

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-subagent-library — DeepSeek Harness 具名子代理库插件" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/MaRi23333/dsh-subagent-library/ci.yml?style=flat-square&label=CI" alt="CI" />
  <img src="https://img.shields.io/github/license/MaRi23333/dsh-subagent-library?style=flat-square" alt="License: Apache-2.0" />
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.5-4d6bfe?style=flat-square" alt="DeepSeek Harness 0.2.2-rc.5" />
</p>

## 简介

把常用的子代理保存在 DeepSeek Harness 里。例如建一个叫「代码审查」的角色，选好模型，写好提示词。下次直接说「让代码审查检查这次改动」，主会话就能找到它并派活。还可以把几个角色编在一起，为每位成员写下分工，需要谁就派谁。

**关闭官方「智能体团队」也能使用完整的编队派遣。** 每次调用只启动一名成员，并返回宿主分配的名字。任务彼此独立时，主代理可以在同一轮分别点名多位成员，并行开始工作。后续分工取决于前一位的结论时，也可以等它汇报后再派。开启智能体团队后，成员还可以通过官方共享任务板协作。

0.4.0 面向 DSH `0.2.2-rc.5`，需要宿主支持可按名称继续对话的原生子代理。从旧版升级请参阅[迁移指南](./MIGRATION.md)和[更新日志](./CHANGELOG.md)。

## 安装

### 桌面客户端（推荐）

桌面客户端与 Web 的插件安装和启用状态各自独立；在 Web 安装不会自动在桌面端启用。桌面图形界面安装无需配置 PATH。

1. 打开桌面客户端，进入侧栏 **插件（Plugins）** → **添加插件（Add plugin）**。
2. 输入 npm 包名 `dsh-subagent-library@latest` 并安装。
3. 安装完成后点击 **立即启用（Enable now）**；只关闭安装完成对话框会让插件保持停用。
4. 仅在界面提示需要重启时，通过应用菜单 **退出（Quit）** 完整退出再重开。关闭窗口可能只是隐藏应用。

启用后打开 **设置 → 子代理库**，选择「角色名册」或「编队」。名册目录可在「存储与备份说明」中查看。

<details>
<summary>备用：使用桌面随附 CLI（Windows / macOS）</summary>

先启动桌面客户端一次以完成初始化。在应用菜单打开 **Manage dsh Command…** → **Install**，注册桌面随附的 `dsh` 命令，再打开新终端；若界面报告 PATH 冲突，先按其提示处理。

通过 **Quit** 完整退出桌面客户端后，使用刚注册的桌面随附 CLI：

```sh
dsh plugin --profile desktop add dsh-subagent-library@latest
dsh plugin --profile desktop list
```

完成后重开桌面客户端。npm 安装的 `dsh` 和 `npx` 不能管理 `desktop` profile。命令注册说明见[官方桌面文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/desktop/README.md#bundled-command-runtime)。

</details>

### Web

以下命令只管理 Web 的插件。使用启动该 Web 实例的同一套、与宿主版本匹配的 `dsh` CLI，从 npm 安装稳定版本：

```sh
dsh plugin --profile web add dsh-subagent-library@latest
```

安装后停止当前 `dsh web` 进程，用同一套 CLI 重新运行 `dsh web`，再刷新页面。

其他安装来源：

```sh
# 从 GitHub 安装（仓库已提交 lib/ 构建产物，安装无需本地构建）
dsh plugin --profile web add github:MaRi23333/dsh-subagent-library

# 从本地目录安装
git clone https://github.com/MaRi23333/dsh-subagent-library.git
cd dsh-subagent-library
pnpm install && pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-subagent-library
```

> 仓库已提交 `lib/` 构建产物，git 安装无需本地构建；改源码后运行 `pnpm run build` 再重启 Web。
> 名册（`~/.dsh/subagents/` 下的条目文件）**热生效**，无需重启。
>
> **渠道切换**：之前从 GitHub / 本地目录安装、现在想跟随 npm 发布升级时，用 `dsh plugin --profile web add dsh-subagent-library@latest` 显式取 npm 最新版。

## 第一次委派

打开 **设置 → 子代理库 → 角色名册**，点「新建角色」，填写角色 ID `text-helper` 和描述，保存即可。模型留空会继承会话模型。也可以在名册目录创建等效的 `text-helper.yaml`（默认位于 `~/.dsh/subagents/`）。

```yaml
description: 整理主会话给出的文字。
persona: 保留原文中的专有名词。
```

让主会话查询 `list_subagents()`，再调用 `delegate({library_id:"text-helper", prompt:"把苹果、香蕉、梨按原顺序编号。"})`。回执中的 `name` 可直接交给官方控制工具。完整结果随后到达父会话。角色也可以从设置里的「子代理库」管理。

## 编队成员与分工

在 **子代理库 → 编队** 中点「新建编队」。编队描述帮助主代理选组，共享说明会随任务发给从这组选中的每位成员。选好角色后，可以直接用角色 ID 填写空白的成员代号，也可以为这项分工起个名字。下面两位都用 `text-helper`，其中 `facts` 负责提取事实，`questions` 负责列出待确认的问题。

同样的设置也可以写入名册目录里的 `_groups/text-review.yaml`。其中 `slot` 对应界面里的“成员代号”。

```yaml
description: 整理材料中的事实与待确认事项。
instructions: 发回结论时注明依据。
members:
  - slot: facts
    role: text-helper
    assignment: 提取有原文依据的事实。
  - slot: questions
    role: text-helper
    assignment: 列出需要补充的信息。
```

| 操作 | 主会话调用 |
| --- | --- |
| 浏览编队 | `list_subagents({kind:"groups"})` |
| 查看成员代号、模型配置和分工 | `list_subagents({group_id:"text-review"})` |
| 派一人核对事实 | `delegate({group_id:"text-review", slot:"facts", prompt:"核对刚才这段文字。"})` |

查询不会启动成员。在上例中，`questions` 只有被另一次调用明确选中才会启动。直接按角色 ID 派遣只带角色人设与本次任务。从编队点名时，首条子代理消息还会带上编队说明和这位成员的分工。再次派遣时会重新读取当前角色和 profile 路由，已启动的成员继续使用原会话。人类也可以用 `/subagent` 查看名册和编队。

用 `/subagent groups text-review` 可以看到哪些成员指定了模型，哪些跟随主会话。角色也可以跟随主会话模型、单独指定思考等级。派发后，顶部子代理列表和官方 `list_agents` 的成员描述显示启动时的模型与已知思考等级，例如 `text-review/facts [model-a · high]`。展开 `delegate` 回执可以查看完整的模型渠道（`provider`）、模型（`model`）和思考等级（`reasoningEffort`）。宿主未提供的值会省略。

**临时换模型**时，可以直接告诉主会话：“派 facts 和 questions 分别复核，facts 照常，questions 这次用我授权的 B 模型。”打开 DSH 左侧的「插件」，在「内置插件配置 → 子智能体 → 模型选择」打开「允许 Agent 为子智能体选择模型」。勾选所需模型，点「保存」，再点左上角「新会话」。主代理可用官方 `list_subagent_models` 查询选项，调用 `delegate` 时一起传入 `provider` 和 `model`，也可以指定 `reasoning_effort`。省略档位会采用所选模型的默认值。下次按角色或成员代号派遣时仍用角色原配置。

会话没有已记录的模型名单时，显式选模仅可指定父会话当前的渠道和模型。宿主无法提供授权状态时，仍可按角色默认配置派遣。智能体团队开关不影响这两种用法。

## 配置与迁移

| 位置或字段 | 行为 |
| --- | --- |
| `<entriesDir>/<role-id>.yaml` | 共享角色，`description` 必填。支持 `persona`、`enabled`、模型路由、`maxTokens`、`maxDepth` 和 `subagentProvider`。 |
| `_profiles/<profile>/<role-id>.yaml` | 当前 profile 的模型路由。可指定 `provider`、`model`、`reasoningEffort` 或显式继承。共享 provider 未在该 profile 注册时沿用会话模型；显式 profile 路由有误会给出诊断。 |
| `_groups/<group-id>.yaml` | 必填组描述和非空、有序的 `members`，可选 `name`、`enabled` 和 `instructions`。每位成员填写代号 `slot` 和角色 `role`，可用 `assignment` 写下默认分工。 |
| `maxDepth` | 不填时采用宿主上限；角色可以进一步收紧，设为 0 时禁止派遣。 |
| `subagentProvider` | 传输默认使用 `spawn`。`fork` 可继承父会话已完成轮次的历史。LLM provider 单独配置。 |
| 旧 `backgroundMode`、`toolFilter` | 旧运行模式统一按异步可续聊执行。带有旧工具限制的角色会保留配置并阻止派遣；确实需要硬限制的角色应先在宿主落实权限。 |

有 profile 的宿主将设置页中的模型修改保存到当前 profile。没有 profile 的宿主可以在同一页编辑共享默认模型，清空后跟随会话。更改共享模型后，绑定旧默认路由的 profile 设置需要重新指定。

角色 ID、编队 ID 和成员代号采用小写字母、数字和短横线，以字母或数字开头，最长 64 字符，并避开 Windows 设备保留名。停用编队后，启用的角色仍可单派。被编队引用的角色需先移除引用才能删除。设置写入保留并发冲突检查，手工修改 YAML 对下次查询和派遣生效。

在当前 profile 的 `cordis.patch.yml` 中可以指定名册位置和默认传输：

```yaml
- id: subagent-library
  config:
    entriesDir: ~/.dsh/subagents
    subagentProvider: spawn
```

备份时一起保留角色、`_profiles/` 和 `_groups/`。设置接口 `/subagent-library/api` 使用 DSH Web Host 的访问边界。将宿主开放给其他设备时，在宿主或反向代理配置访问控制。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build   # host: lib/index.js；client: lib/client.js
```

- 开发依赖仍锁定 DSH `0.1.0-rc.6`（见 package.json devDependencies），不等于当前使用宿主版本。其他版本如接口漂移请对照 [deepseek-harness 仓库](https://github.com/deepseek-ai/deepseek-harness) 相应 tag 调整。

## License

[Apache-2.0](./LICENSE)。本仓库内联构建产物的第三方许可证声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

本插件是独立社区项目，与 DeepSeek 无任何隶属或背书关系；`DeepSeek Harness` 名称仅用于标明兼容平台。
