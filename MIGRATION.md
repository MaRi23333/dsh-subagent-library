# 迁移指南：0.2.x → 0.3.x（名册目录化）

**中文指南（English guide below）**

---

## TL;DR（三步走）

1. **升级插件并重启 dsh web** —— 什么都不用改，你的旧配置会自动迁移；
2. **验证**：`/subagent` 或设置页能看到全部旧条目，且名册目录里多了一批 `<id>.yaml`；
3. **清理**（可选但推荐）：设置页点「清除旧条目」，或手动删掉 settings.yaml 里的旧 `entries` 段。

旧配置在 0.3.x 全程兜底可读，不清除也不影响使用；**0.4 起才停止读取**。

---

## 0.3 变了什么

0.2.x 把所有具名子代理塞在 `~/.dsh/settings.yaml` 的 `subagent-library.entries` 下面——一个文件里混着插件配置和一大坨角色定义，长、难注释、难版本管理。

0.3 起，**一个具名子代理一个 YAML 文件**：

```
~/.dsh/subagents/          ← 默认名册目录（可用 entriesDir 改）
  k3-reviewer.yaml         ← id = 文件名
  glm-reader.yaml
  ...
```

```yaml
# k3-reviewer.yaml 示例（字段与旧 entries 内完全一致，注释随便写）
description: 独立只读审核，支持图片视觉走查
provider: kimi-coding
model: k3-256k
persona: |
  你是独立审核 agent……
toolFilter:
  deny: [write, edit]
maxDepth: 1
backgroundMode: continuable
```

`settings.yaml` 里只保留插件级配置：

```yaml
subagent-library:
  # 可选：自定义名册目录（默认 ~/.dsh/subagents，支持 ~ 与相对路径）
  # entriesDir: ~/.dsh/subagents
  # entries: ← 0.2.x 的旧段，0.3.x 只读兜底，确认迁移成功后可删
```

文件**热生效**：改完保存即可，无需重启。设置页与手编文件的数据**双向等价**，但要注意：通过设置页保存某个条目时，**该条目的文件会被重写为程序生成的标准 YAML**（这个文件里的手写注释与自定义排版会丢失）；**你未在本次保存中改动的其他文件一律原样保留**。想保留注释的手编文件，请直接手编，别在设置页里动它。

## 自动迁移是怎么工作的

升级到 0.3 并重启后，**首次使用名册时**（打开设置页、调用 `list_subagents`、或第一次 `delegate`）插件会：

1. 读取 settings.yaml 里的旧 `entries`；
2. 对每个条目：**如果名册目录里还没有同名 `<id>.yaml`，就导出一个**；
   - 已存在同名文件 → **跳过，绝不覆盖**（你手写的文件是安全的）；
   - id 非法（大写、超长、Windows 保留名）→ 跳过并在诊断里说明；
3. **settings 里的旧段在迁移阶段原样保留**——它是你的回滚备份：自动迁移后旧副本仍保留，只有清理才会移除。注意区分两种操作：设置页**删除条目**会删除对应名册文件，并一并移除其旧副本；点**「清除旧条目」**只移除已被文件覆盖的旧副本，不动任何名册文件。

迁移是逐条幂等的：重启多少次都只会导出缺的那几条，重复内容不会翻倍。

## 你需要做的

### 第 1 步：升级 + 重启

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-subagent-library@latest
```

然后重启 dsh web、刷新页面。

### 第 2 步：验证迁移

任选其一：

- 命令面板跑 `/subagent`，确认旧条目全部在列；
- 打开 设置 → 子代理库：条目卡片正常显示即已迁移（若某条带 `legacy` 徽标且名册目录没有对应文件，说明该条还是旧数据在兜底，看下方 FAQ）；
- 看一眼名册目录（默认 `~/.dsh/subagents/`），确认 `<id>.yaml` 都在，随手打开一个核对字段。

### 第 3 步：清理旧段（可选，推荐）

确认名册工作正常后，把 settings.yaml 里的旧 `entries` 段清掉，两种方式：

- **设置页一键清除（推荐）**：子代理库卡片顶部会出现迁移横幅「N 个旧条目已导出为名册文件……」，点「清除旧条目」即可。该操作只删除**已被文件覆盖**的旧副本，名册文件不受影响；
- **手动删除**：编辑 `~/.dsh/settings.yaml`，删掉 `subagent-library.entries:` 整段（保留 `subagentProvider` / `entriesDir` 等插件级键）。

> 不清理会怎样？——什么都不会坏。文件优先生效，旧段只是躺着（设置页会持续显示提示信息）。0.4 起插件停止读取旧段，届时再删也行。

## 回滚（想退回 0.2.x）

直接安装旧版本即可：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-subagent-library@0.2.8
```

0.2.x 只读 settings.yaml——只要你不曾删除旧 `entries` 段，回滚后名册原样可用（0.3 之后手编的名册文件它看不见；所以**清理旧段之前请想清楚是否还要回滚**）。旧副本就是回滚的数据源：手动编辑或删除旧副本（含删除条目、一键清除）会让回滚回到删除/编辑当时的旧快照——0.3 期间在名册文件里做的修改不会跟着回去。

## FAQ

**Q：我手写的 `<id>.yaml` 会被迁移覆盖吗？**
不会。迁移只导出名册目录里**不存在**的 id；已有文件一律跳过。

**Q：文件名有什么要求？**
`<id>.yaml`（或 `.yml`），id 必须全小写、匹配 `[a-z0-9][a-z0-9-]*`、长度 ≤ 64，且不能是 Windows 保留设备名（`con`、`nul`、`aux`…）。同一 id 的 `.yaml`/`.yml` 并存会报冲突诊断，只留一个。

**Q：某个文件写坏了会怎样？**
只有那一个条目失效：它被跳过，并在 `list_subagents`、`/subagent`、设置页 diagnostics 里给出原因，其余条目照常。改好文件即恢复。**特别注意**：如果同名条目在 settings 里还有旧副本（自动迁移后旧副本仍保留；点「清除旧条目」或删除条目后才移除），插件会用**旧副本兜底继续服务**，并在 diagnostics 里以 error 标明「delegate 使用的是旧配置」——看到这条请先修文件。

**Q：怎么临时停用一个子代理（不删文件）？**
文件里加一行 `enabled: false`（或设置页关掉「启用」开关）。停用的条目仍可见，但 `delegate` 会拒绝并提示。注意：仍以 **legacy 兜底**方式服务的条目（见上一条）不支持停用——先在设置页保存一次让它晋升为文件，再停用。

**Q：想给某个子代理单独设置思考强度？**
0.3 新增 `reasoningEffort` 字段：填适配器自有值（如 `max` / `high` / `medium` / `low`），留空随父会话默认。子代理被路由到不同模型时，官方会自动丢弃继承来的思考强度，因此不设置也不会跨模型泄漏。取值由模型适配器解释（与官方 agent-default-model 的 reasoningEffort 同一通道）：官方模型选择器启用时会覆盖/清空继承值；插件只接受 id 形态的值（字母数字与 `.` `_` `-`），写别的会在保存时被拒绝。

**Q：迁移会失败吗？失败了会怎样？**
单条导出失败只影响那一条（它继续以 legacy 兜底，diagnostics 会说明）；整体故障（如目录不可写）时条目全部走 legacy 兜底且设置页有警告横幅——**下次使用名册时会自动重试，重启 dsh web 也可立即重试**，不需要手工干预。

**Q：名册目录能换地方吗？**
能。settings.yaml 里设 `subagent-library.entriesDir`（支持 `~` 与相对路径，相对路径锚定 `~/.dsh`）。

**Q：多台机器怎么同步名册？**
把名册目录纳入你的 dotfiles/git 即可——每条目一个文件，diff 友好。settings.yaml 里的旧段不建议同步。

---

# Migration Guide: 0.2.x → 0.3.x (directory-backed roster)

**TL;DR (3 steps)**

1. **Upgrade and restart dsh web** — nothing to change by hand; your legacy config migrates automatically.
2. **Verify**: run `/subagent` or open the settings page — all old entries are listed, and the roster directory now holds one `<id>.yaml` per entry.
3. **Clean up (optional but recommended)**: click “清除旧条目” on the settings card, or delete the legacy `entries` section from settings.yaml manually.

**What changed** — the roster moved from the inline `subagent-library.entries` map in `~/.dsh/settings.yaml` to **one YAML file per named subagent** under `~/.dsh/subagents/` (configurable via `subagent-library.entriesDir`). Files are hot-reloaded. Entry DATA is equivalent between the settings page and hand-edited files, but saving an entry from the settings page rewrites THAT entry's file as generated YAML (hand-written comments in that one file are lost); untouched files are left alone.

**Automatic migration** — on the first roster use after upgrading, each legacy entry is exported to `<id>.yaml` **only if that file does not exist yet** (hand-written files are never overwritten; re-runs are idempotent). The legacy settings copies are **kept** as a rollback fallback; files take precedence. Legacy reading stays working throughout 0.3.x and is **removed in 0.4**. Deleting an entry from the settings page removes its roster file **and** its legacy copy; the one-click cleanup only removes legacy copies that files already shadow and never touches roster files. Legacy copies persist after automatic migration until you clear them.

**Rollback** — install the old version (`dsh-subagent-library@0.2.8`); as long as you have not deleted the legacy `entries` section, 0.2.x keeps working exactly as before. The legacy copies are the rollback data source: editing or deleting them (including deleting entries or one-click cleanup) makes rollback return to the snapshot as of that moment — changes made in 0.3 roster files do not come back with the rollback.

**New in 0.3** — per-entry `enabled` (disable without deleting) and `reasoningEffort` (adapter-owned thinking-effort id such as `max`, passed through the official `agentOptions` override); broken roster files are skipped with visible diagnostics instead of breaking the roster.

See [CHANGELOG.md](./CHANGELOG.md) for the full list of changes.
