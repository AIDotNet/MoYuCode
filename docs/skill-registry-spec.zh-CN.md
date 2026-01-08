# OneCode 技能市场与注册表方案（简化版优先）

## 0. 简化版优先级（当前阶段）
- 以 GitHub API 读取本仓库 `skills/` 目录与统一 `skills/index.json` 作为唯一数据源。
- 不建设独立 API 服务，OneCode 直接对接 GitHub API。
- OneCode 内置 UI 提供远端浏览与本地安装管理（覆盖 Codex 与 ClaudeCode）。
- 无人工审核，发布即生效；以风险提示与下架标记治理。

## 1. 目标与原则
- 面向公开社区与企业用户，统一技能分发入口。
- 不涉及商业化与付费流程。
- 完全兼容 `SKILL.md`，不要求新增强制文件。
- 使用 GitHub API 获取索引与 `SKILL.md` 内容。
- OneCode 内置 UI 完成搜索、下载与覆盖安装。

## 2. 范围与非目标
范围包含：
- 本仓库 `skills/` 目录与统一 JSON 索引。
- OneCode UI 的市场浏览与本地技能管理。
- GitHub 贡献流程（PR/Release）作为发布方式。
- 风险提示、举报与下架标记。

非目标：
- 独立 Registry 服务与自建账号体系。
- 付费或订阅体系。
- 人工审核与内容审批。
- ClaudeCode 官方安装逻辑的集成方案。

## 3. 数据源与目录结构（GitHub）
- 根目录新增 `skills/` 目录作为配置入口。
- 统一索引文件：`skills/index.json`。
- 推荐目录结构：`skills/{owner}/{skill}/`，避免重名冲突。
- `SKILL.md` 与技能文件必须位于本仓库 `skills/{owner}/{skill}/` 下，包即目录内容。

建议的索引字段（示意）：
```json
{
  "version": 1,
  "generatedAt": "2026-01-07",
  "skills": [
    {
      "slug": "owner/skill",
      "name": "Skill Name",
      "summary": "Short description",
      "visibility": "public",
      "tags": ["cli", "productivity"],
      "services": {
        "codex": { "compatible": true },
        "claudecode": { "compatible": true }
      },
      "skillMd": {
        "path": "skills/owner/skill/SKILL.md"
      },
      "package": {
        "basePath": "skills/owner/skill",
        "files": [
          { "path": "SKILL.md", "sha256": "..." }
        ]
      },
      "version": "1.2.0",
      "buildId": "20260107.1",
      "status": "active",
      "updatedAt": "2026-01-07T10:00:00Z"
    }
  ]
}
```

## 4. 可见性与访问规则
- public：可搜索、可浏览、可安装（含未登录用户）。
- org：仅组织成员可见与安装，不进入公共搜索。
- unlisted：仅发布者中心可见；不可搜索、不可访问、不可安装。

说明：unlisted 不进入公共索引；org 技能建议通过组织私有索引或私有仓库提供。

## 5. 发布与版本策略（GitHub 贡献）
- 发布通过更新 `skills/index.json` 与对应文件完成。
- 允许覆盖同版本；保留 `buildId` 与更新时间。
- 版本状态：`active` 与 `yanked`（下架，不可安装但保留历史）。
- 版本页需提示“此版本已更新”并显示更新时间。

## 6. OneCode 安装体验（简化版）
- 市场内搜索/浏览 -> 详情页 -> 选择版本 -> 安装。
- 同名技能直接覆盖安装；安装失败则回滚或保留旧版本。
- 安装前展示风险提示标签（不阻塞）。
- 本地记录来源、版本、构建指纹与安装时间。
- 更新提示包含两类：新版本与同版本更新。
- 支持从本地 zip/tar 导入技能包。
- 必须支持离线安装（仅依赖本地导入包）。

## 7. 内容展示与发现
- 详情页主体渲染 `SKILL.md` 内容。
- 可选解析 front matter 作为标题、标签、兼容性信息。
- 发现渠道仅对 public 开放：搜索、分类、趋势、最近更新。
- org 技能仅在组织内可见；unlisted 不出现。

## 8. 组织与企业能力
- 组织以 GitHub Organization 为准，成员关系以 GitHub 为准。
- 组织成员可见 org 技能；发布权限由 GitHub 权限控制。
- 组织邀请可通过 GitHub 的邮件邀请完成。
- 组织主页展示 public 与 org 技能。

## 9. 风险提示与治理
- 自动扫描生成风险提示（外联、脚本执行等）。
- 举报入口可触发风险标识与下架流程。
- 可信标识：GitHub 认证发布者、组织验证。
- 无人工审核，不阻塞发布。

## 10. 统计与隐私
- 全局统计以 GitHub 可用指标为准（如 release 下载量）。
- 本地安装统计仅保存在客户端，不上传个人敏感信息。

## 11. 关键用户旅程
- 未登录用户：搜索 public -> 安装 -> 使用。
- 发布者：通过 GitHub 提交更新 -> 版本上线。
- 组织：成员加入 -> 浏览 org 技能 -> 安装与更新。

## 12. 字段校验规则（简化版）
- `skills/index.json` 必填：`version`（整数）、`generatedAt`（日期或时间）、`skills`（数组）。
- `slug` 需符合 `owner/skill` 形式，建议只允许字母、数字、`-`、`_`、`.`。
- `visibility` 取值限定为 `public`、`org`、`unlisted`。
- `skillMd.path` 必填，且必须位于 `skills/{owner}/{skill}/SKILL.md`。
- `package.basePath` 必填，且必须是 `skills/{owner}/{skill}`。
- `package.files` 必填，元素包含 `path` 与 `sha256`。
- `package.files[].path` 必须相对 `basePath`，且不允许跨目录引用。
- `version` 必填，建议语义化；`buildId` 与 `updatedAt` 必填。
- `status` 取值限定为 `active` 或 `yanked`。

## 13. 同版本覆盖策略细则
- 允许覆盖同版本，但必须更新 `buildId` 与 `updatedAt`。
- 覆盖同版本时需更新 `package.files[].sha256`，并提示“此版本已更新”。
- 客户端若检测 `version` 相同但 `buildId` 不同，视为“同版本更新”。
- `yanked` 版本不可安装；若恢复为 `active`，需更新 `buildId` 与 `updatedAt`。

## 14. UI 字段清单（简化版）
- 列表：名称、简介、标签、可见性、兼容服务（Codex/ClaudeCode）、版本、更新时间、状态。
- 详情：`SKILL.md` 渲染、版本列表、`buildId`、更新时间、风险提示、安装按钮。
- 已安装信息：来源（Codex/ClaudeCode）、已装版本与 `buildId`、安装时间、是否有更新。
- 导入入口：本地压缩包导入与离线安装提示。

## 15. `skills/index.json` 最小示例
```json
{
  "version": 1,
  "generatedAt": "2026-01-07",
  "skills": [
    {
      "slug": "onecode/hello-skill",
      "name": "Hello Skill",
      "summary": "A minimal example skill",
      "visibility": "public",
      "tags": ["example"],
      "services": {
        "codex": { "compatible": true },
        "claudecode": { "compatible": true }
      },
      "skillMd": {
        "path": "skills/onecode/hello-skill/SKILL.md"
      },
      "package": {
        "basePath": "skills/onecode/hello-skill",
        "files": [
          { "path": "SKILL.md", "sha256": "REPLACE_WITH_SHA256" }
        ]
      },
      "version": "1.0.0",
      "buildId": "20260107.1",
      "status": "active",
      "updatedAt": "2026-01-07T10:00:00Z"
    }
  ]
}
```

## 16. 目录树样例（本仓库）
```
skills/
  index.json
  onecode/
    hello-skill/
      SKILL.md
      scripts/
        hello.ps1
```

## 17. OneCode 本地技能管理交互与状态流转
交互流程（简化版）：
- 入口：OneCode -> Skills。
- 顶部过滤：All / Codex / ClaudeCode。
- 列表页：显示本地已安装与远端可安装技能。
- 详情页：渲染 `SKILL.md`，提供安装/覆盖/卸载/导入。
- 导入：选择本地 zip/tar -> 校验 `sha256`（如可用）-> 解压 -> 覆盖安装。

状态流转（简化版）：
- NotInstalled -> Installed（安装或导入成功）。
- Installed -> UpdateAvailable（检测到新版本或同版本更新）。
- UpdateAvailable -> Installed（更新完成）。
- Installed -> NotInstalled（卸载成功）。
- Installed -> InstallFailed（校验或解压失败，保留旧版本）。
