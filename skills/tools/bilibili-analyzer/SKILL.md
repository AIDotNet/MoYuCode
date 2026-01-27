---
name: bilibili-analyzer
description: 自动分析B站视频内容，下载视频并拆解成帧图片，使用AI分析并生成详细的专题文档或实操教程。
metadata:
  short-description: B站视频AI分析工具
source:
  repository: https://github.com/yt-dlp/yt-dlp
  license: Unlicense
---

# Bilibili Video Analyzer

## Description

B站视频内容分析工具。提供视频URL后，自动下载视频、拆解成帧图片，然后使用AI分析内容，最终生成**高质量的专题文档或实操教程**。

**核心特点**:
- 不是简单的时间线记录，而是**重新组织整理**成一篇完整的文档
- 实操类视频 → 生成**可直接使用的操作教程**
- 知识类视频 → 生成**结构化的专题文档**
- 报告中插入关键截图，使用 `![描述](./images/frame_xxxx.jpg)` 格式

## Trigger

- `/bilibili-analyzer` 命令
- 用户请求分析B站视频
- 用户提供B站视频链接并要求分析

## Workflow

### Step 1: 下载视频并拆帧

使用提供的脚本下载视频并拆解成帧图片：

```bash
python scripts/prepare.py "<视频URL>" -o <输出目录>
```

参数说明：
- `-o, --output`: 输出目录，默认当前目录
- `--fps`: 每秒提取帧数，默认1（长视频可用0.5或0.2）

执行后会生成：
- `video.mp4` - 下载的视频
- `images/` - 帧图片目录

### Step 2: 分析帧图片

使用 Task 工具并行分析 `images/` 目录中的图片，提取界面内容、文字、操作步骤等信息。

### Step 3: 生成文档

将分析结果**重新组织整理**成 `视频分析.md`：
- 实操类视频 → 操作教程格式
- 知识类视频 → 专题文档格式

**重要**: 不要按时间线流水账，要像写文章一样组织内容。

## 输出格式

### 实操教程类

```markdown
# {教程主题}

## 简介
{教程目标和前置条件}

## 环境准备
{需要的软件和配置}

## 操作步骤

### 1. {步骤标题}
{说明}
![截图](./images/frame_xxxx.jpg)

### 2. {步骤标题}
...

## 完整代码
{汇总代码}

## 总结
{核心要点}
```

### 知识文档类

```markdown
# {主题}

## 概述
{主题介绍}

## {章节标题}
{内容}
![配图](./images/frame_xxxx.jpg)

## 核心要点
{总结}
```

## Requirements

- **yt-dlp**: `pip install yt-dlp`
- **ffmpeg**: https://ffmpeg.org/download.html

## 文档质量要求

1. **不要时间线流水账** - 重新组织内容
2. **结构清晰** - 有章节划分和逻辑顺序
3. **配图恰当** - 路径用 `./images/frame_xxxx.jpg`
4. **代码完整** - 可直接复制使用
5. **独立可读** - 不看视频也能理解

## Tags

`bilibili`, `video-analysis`, `ai`, `frame-extraction`, `markdown`, `tutorial`

## Compatibility

- Codex: ✅
- Claude Code: ✅
