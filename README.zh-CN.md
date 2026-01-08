# OneCode

<div align="center">

**一键管理 Codex 和 Claude Code，这是开源版的 ZCode**

[![CI](https://github.com/AIDotNet/OneCode/workflows/CI/badge.svg)](https://github.com/AIDotNet/OneCode/actions)
[![Release](https://img.shields.io/github/v/release/AIDotNet/OneCode)](https://github.com/AIDotNet/OneCode/releases)
[![License](https://img.shields.io/github/license/AIDotNet/OneCode)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

## 简介

OneCode 是一款开源工具，旨在帮助用户通过 Web 界面便捷操作 [Codex](https://github.com/openai/codex) 和 [Claude Code](https://claude.ai/code)。它支持本地部署，并可通过内网映射实现外网访问，方便用户通过手机等设备远程使用。部分设计体验参考了 [ZCode](https://zcode.dev/)。

## 功能特性

- **Web 界面**：基于 React + TypeScript + Tailwind CSS 构建的现代化响应式 Web UI
- **AI 集成**：与 OpenAI Codex 和 Claude Code 无缝集成
- **会话管理**：可视化的 AI 编程会话管理和详细历史记录
- **项目工作区**：集成文件浏览器和代码编辑器，实现无缝开发工作流
- **Token 使用追踪**：监控和可视化各会话的 Token 消耗
- **实时更新**：通过服务器推送事件（SSE）实现实时 AI 响应流
- **跨平台**：支持 Windows、Linux 和 macOS
- **系统托盘**：Windows 桌面应用程序支持托盘图标

## 截图

### 系统托盘
运行 OneCode.Win.exe 后，会在系统托盘显示图标，后台服务自动运行。

### 项目选择
自动扫描本地已使用 Codex 的项目并加载到界面，用户可选择项目进入工作区。

### 会话管理
- 发起新对话或选择历史会话
- 加载历史会话以恢复完整上下文
- 查看会话详情，包括 Token 使用情况和时间线

### 文件浏览器
集成文件浏览器，可直接查看和编辑代码文件，同时与 AI 进行交互。

## 下载与安装

### Windows 桌面应用

1. 访问 [GitHub 发布页](https://github.com/AIDotNet/OneCode/releases)
2. 下载最新的 Windows 压缩包（`OneCode-*-win-x64.zip`）
3. 解压后运行 `OneCode.Win.exe`
4. 程序会在系统托盘显示图标
5. 打开浏览器访问 `http://localhost:9110/`

### Linux

1. 从[发布页](https://github.com/AIDotNet/OneCode/releases)下载最新的 Linux 包（`OneCode-*-linux-x64.tar.gz`）
2. 解压文件：
   ```bash
   tar -xzf OneCode-*-linux-x64.tar.gz
   cd OneCode-*-linux-x64
   ```
3. 直接运行：
   ```bash
   ./run.sh
   ```
4. 或安装为 systemd 服务：
   ```bash
   sudo ./install-service.sh
   ```

### macOS

1. 从[发布页](https://github.com/AIDotNet/OneCode/releases)下载最新的 macOS 包（`OneCode-*-osx-x64.tar.gz`）
2. 解压文件：
   ```bash
   tar -xzf OneCode-*-osx-x64.tar.gz
   cd OneCode-*-osx-x64
   ```
3. 直接运行：
   ```bash
   ./run.sh
   ```
4. 或安装为 launch daemon：
   ```bash
   sudo ./install-service.sh
   ```

## 环境要求

- **.NET 10.0 运行时**（独立可执行文件已包含）
- **Codex CLI**（Codex 集成所需）：
  ```bash
  npm install -g @openai/codex
  ```

## 使用说明

### 访问 OneCode

启动应用程序后，在浏览器中打开：

- HTTP：`http://localhost:9110/`
- HTTPS：`https://localhost:9111/`（如已配置）

### 项目工作流

1. **选择项目**：OneCode 自动扫描有 Codex 使用历史的项目
2. **进入工作区**：点击项目进入其工作空间
3. **开始对话**：开始新聊天或加载历史会话
4. **查看代码**：使用集成的文件浏览器查看和编辑文件
5. **监控使用**：追踪 Token 使用和会话统计

### 会话管理

- 点击右上角的会话列表按钮
- 选择一个历史会话
- 点击"加载会话"恢复完整上下文
- 查看会话详情，包括 Token 使用、时间线和元数据

## 开发指南

### 后端 (C# / ASP.NET Core)

```bash
# 构建
dotnet build src/OneCode/OneCode.csproj

# 运行 (HTTP)
dotnet run --project src/OneCode/OneCode.csproj --launch-profile http

# 运行 (HTTPS)
dotnet run --project src/OneCode/OneCode.csproj --launch-profile https
```

### 前端 (React / Vite)

```bash
cd web

# 安装依赖
npm ci

# 开发服务器
npm run dev

# 生产构建
npm run build

# 代码检查
npm run lint
```

### 构建完整应用

CI 流水线自动构建前端和后端：

```bash
# 安装前端依赖
npm ci

# 构建前端
npm run build

# 同步前端到后端 wwwroot
rsync -a --delete web/dist/ src/OneCode/wwwroot/

# 构建后端
dotnet build src/OneCode/OneCode.csproj -c Release
```

## 架构

OneCode 采用双栈架构：

### 后端
- **框架**：ASP.NET Core 10.0 Web API
- **通信**：通过 stdio 与 Codex app-server 进行 JSON-RPC 通信
- **数据库**：SQLite + Entity Framework Core
- **协议**：Agent-to-Agent (A2A) 协议用于流式 AI 交互

### 前端
- **框架**：React 19 + TypeScript
- **构建工具**：Vite
- **样式**：Tailwind CSS v4
- **状态管理**：React Router + 本地组件状态
- **UI 组件**：Radix UI + 自定义动画

详细架构文档请参阅 [CLAUDE.md](CLAUDE.md)。

## 贡献

欢迎贡献！请随时提交问题或拉取请求。

1. Fork 本仓库
2. 创建特性分支
3. 提交更改
4. 推送到分支
5. 创建拉取请求

## 许可证

本项目采用 MIT 许可证 - 详情请参阅 [LICENSE](LICENSE) 文件。

## 社区

- GitHub: [https://github.com/AIDotNet/OneCode](https://github.com/AIDotNet/OneCode)
- 问题反馈: [https://github.com/AIDotNet/OneCode/issues](https://github.com/AIDotNet/OneCode/issues)
- 讨论区: [https://github.com/AIDotNet/OneCode/discussions](https://github.com/AIDotNet/OneCode/discussions)

## 致谢

- 灵感来源于 [ZCode](https://zcode.dev/)
- 基于 [OpenAI Codex](https://github.com/openai/codex) 和 [Anthropic Claude Code](https://claude.ai/code) 构建

社区微信：wk28u9123456789
