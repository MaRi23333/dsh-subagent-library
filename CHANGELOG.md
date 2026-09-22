# 更新日志 / Changelog

本文件记录 dsh-subagent-library 的面向用户的重要变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

This file documents user-facing changes. Format loosely follows [Keep a Changelog]; versions follow [SemVer].

## [0.3.0] — 2026-09-10（发布候选，未发布 / release candidate, unreleased）

### 变更 / Changed（重要：存储位置变化）

- **名册存储目录化**：具名子代理从 `settings.yaml` 的 `subagent-library.entries` 迁移为 **一个子代理一个 YAML 文件**，默认目录 `~/.dsh/subagents/`（可用 `subagent-library.entriesDir` 自定义，支持 `~` 与相对路径）。
  - **The roster now lives as one YAML file per named subagent** (default `~/.dsh/subagents/`), replacing the inline `entries` map in settings.yaml.
- **旧条目自动迁移**：升级后首次使用名册时，settings 里的旧 `entries` 会被**逐条**导出为 `<id>.yaml`（已存在同名文件绝不覆盖；重复重启幂等）。settings 中的旧副本**保留**作回滚兜底，文件优先生效；0.3.x 内旧配置仍可读，**0.4 起停止读取**。
  - On first use the legacy `entries` are exported entry-by-entry (never overwriting hand-written files); the legacy copies are kept as a rollback fallback and win nothing — files take precedence. Legacy reading is removed in 0.4.
- **一键清除旧条目**：设置页「子代理库」卡片新增迁移横幅与「清除旧条目」按钮（只清除已被文件覆盖的旧副本，不碰名册文件）；也可手动删除 settings 中的旧 `entries` 段。详见 [MIGRATION.md](./MIGRATION.md)。
  - The settings page gains a migration banner with a one-click "clear legacy copies" action. See [MIGRATION.md](./MIGRATION.md).
- 设置页 UI 重排：对齐个性化指令编辑器的视觉风格（主题中性 rgba 配色、8px 圆角卡片、蓝色主操作/红色危险按钮、tinted 横幅、chip 徽标），整卡加宽至 860px；**角色提示词编辑区按内容自适应高度**（110–440px 夹紧，短文本紧凑、长文本展开），描述/persona 等正文字段换回界面字体并加大字号，长文本可读性优先；描述字段为单行 textarea 可拖展；后台模式挪至思考强度行，固定宽度控件不再被挤压。
  - Settings-page restyle: aligned with the personal-instruction editor (theme-neutral rgba palette, 8px rounded cards, blue primary / red danger buttons, tinted banners, chip badges), card widened to 860px; the persona textarea auto-sizes to its content (clamped 110-440px); description/persona body text is back to the UI face at a larger size; the description field is a one-line textarea you can drag taller; background mode moved next to reasoning effort so fixed-width controls stop getting squeezed.

### 新增 / Added

- **`reasoningEffort` 条目字段**：为单个具名子代理指定思考强度（adapter 自有值，如 `max` / `high` / `medium` / `low`；留空随父会话默认）。走官方 `agentOptions.reasoningEffort` 覆盖通道；子代理换了模型路由时，官方会自动丢弃继承来的思考强度，因此未显式设置不会跨模型泄漏。
  - New per-entry `reasoningEffort` field (adapter-owned id, e.g. `max`), passed through the official `agentOptions.reasoningEffort` override; inherited efforts are auto-dropped by the harness when the child's route differs.
- **`enabled` 条目字段**：文件内写 `enabled: false` 停用条目——目录与设置页仍可见，`delegate` 明确拒绝；设置页提供启用开关。
  - New `enabled` flag to disable an entry without deleting its file.
- **坏文件不炸名册**：解析/校验失败、`.yaml`/`.yml` 同 id 冲突、大写文件名等一律跳过并以 diagnostics 呈现在 `list_subagents`、`/subagent` 与设置页。
  - Broken roster files are skipped and surfaced as diagnostics instead of breaking the roster.
- 设置页：迁移横幅、legacy 徽标、diagnostics 面板；409 冲突保留未保存草稿，仅切换到最新基线（响应带回新视图），再次保存即为覆盖。
  - Settings page: migration banner, legacy badge, diagnostics panel; a 409 conflict keeps your unsaved draft and only switches to the latest baseline (the response carries the fresh view) — saving again overwrites.
- 名册目录新增 **`_backups/` 备份约定**：插件不做自动备份，按惯例 agent/人在改条目前把原文件复制进 `_backups/`；`_` 前缀的文件/目录（`_backups/`、`_draft.yaml`…）一律视为非名册内容，**静默忽略**（不再产生诊断噪音）。
  - Roster-directory `_backups/` convention: the plugin never auto-backs up — by convention, agents (or humans) copy the original file into `_backups/` before editing; anything `_`-prefixed (files or directories) is treated as non-roster content and silently ignored (no more diagnostic noise).

### 修复 / Fixed

- **`.yml` 名册生命周期修复**：名册同时读取 `.yaml`/`.yml`；设置页保存有变化的条目统一收敛为 `<id>.yaml` 并移除同 id 的 `.yml`，删除条目同时清理两个后缀，避免删除 `.yaml` 后旧 `.yml` 复活。
  - **`.yml` roster lifecycle fixed**: the roster reads both `.yaml` and `.yml`; saving changed content through the settings page converges to `<id>.yaml` and removes the same-id `.yml`; deleting an entry removes both suffixes, preventing an old `.yml` from resurrecting after `.yaml` is deleted.
- **修复设置页保存/删除的 HTTP 重复响应**：补齐分支返回，确保 delete/save 每次只发送一次 HTTP 响应，避免真实服务触发 `ERR_HTTP_HEADERS_SENT`。
  - **Duplicate HTTP responses fixed**: delete/save handlers now return after sending their response, so each request is answered exactly once and the real server avoids `ERR_HTTP_HEADERS_SENT`.
- **双审加固（K3 实现复审 + GLM 红队）**：设置页保存**跳过内容未变的条目**——不再把未触碰的手写 YAML 文件重写为生成格式（手写注释得以保留）；名册文件损坏且存在同名 legacy 副本时，升级为 **error 级诊断**并明确提示「delegate 使用的是旧配置」（不再静默回退）；409 冲突**保留用户未保存的草稿**（只切换到最新基线，再次保存才会覆盖）；迁移失败（整体或单条）**自动重试**而非进程内永久搁浅；`reasoningEffort` 保存时校验为 effort id 形态（字母数字与 `._-`）；设置页只读时「清除旧条目」响亮 403 而非假成功；客户端补齐 wire 契约测试（parseView 此前丢失 legacyCount 导致迁移横幅不渲染的 bug 即在此层）。
  - Dual-review hardening (K3 implementation review + GLM red team): settings-page saves **skip unchanged entries** (untouched hand-written YAML files are no longer rewritten into generated format, preserving comments); a broken roster file with a same-id legacy copy now surfaces an **error-level** diagnostic saying delegation is using the old config (no more silent fallback); a 409 conflict **keeps the unsaved draft** (only the baseline switches — saving again overwrites); failed migration (whole-batch or per-entry) **retries automatically** instead of latching for the process lifetime; `reasoningEffort` is validated as an effort id on save (alphanumerics and `._-`); the read-only settings page refuses "clear legacy" loudly with 403 instead of faking success; client wire-contract tests added (parseView previously dropped legacyCount, which was exactly where the migration banner failed to render).

### 内部 / Internal

- 每次操作实时读目录（无缓存、无 watcher）；单条目写入原子化（临时文件 + rename 带重试）；id 规则加长度 ≤64 与 Windows 保留设备名黑名单；BOM 兼容；未知字段大声拒绝。
  - Fresh directory reads per operation; atomic per-file writes with rename retries; id length cap + Windows reserved-name blacklist; BOM tolerance; loud unknown-field rejection.

## [0.2.8] — 2026-09-09

- 设置页导航图标装饰（decorateSettingsNavIcon）。

## [0.2.7] — 2026-09-09

- 修复：`toolFilter` 改为按**调用方会话的可限制集合**解析（此前按可见性，`subagent` 等 scope-local 工具会让委派整单失败）；忽略的名字带原因标注；`allow` 全不可应用时拒绝委派；`list_subagents` 目录同步展示生效后的过滤摘要。

## [0.2.6] — 2026-09-06

- DSH 0.1.2-rc.1 兼容性验证与声明（devDependencies 仍锁 rc.6）。

## [0.2.5] — 2026-09-05

- 修复设置页保存 400（移除保存期工具名预检，委派期 `tools.restrict` 为准）；新条目卡补齐缺失字段。

[Unreleased]: https://github.com/MaRi23333/dsh-subagent-library/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MaRi23333/dsh-subagent-library/compare/v0.2.8...v0.3.0
[0.2.8]: https://github.com/MaRi23333/dsh-subagent-library/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/MaRi23333/dsh-subagent-library/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/MaRi23333/dsh-subagent-library/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/MaRi23333/dsh-subagent-library/compare/v0.2.4...v0.2.5
