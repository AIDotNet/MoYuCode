# OneCode

<div align="center">

**Manage Codex and Claude Code with one click - The open-source version of ZCode**

[![CI](https://github.com/AIDotNet/OneCode/workflows/CI/badge.svg)](https://github.com/AIDotNet/OneCode/actions)
[![Release](https://img.shields.io/github/v/release/AIDotNet/OneCode)](https://github.com/AIDotNet/OneCode/releases)
[![License](https://img.shields.io/github/license/AIDotNet/OneCode)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

## Introduction

OneCode is an open-source tool designed to help users conveniently operate [Codex](https://github.com/openai/codex) and [Claude Code](https://claude.ai/code) through a web interface. It supports local deployment and can be accessed externally through intranet mapping, making it convenient for users to use remotely via mobile devices and other platforms. Part of the design experience is inspired by [ZCode](https://zcode.dev/).

## Features

- **Web Interface**: Modern and responsive web UI built with React + TypeScript + Tailwind CSS
- **AI Integration**: Seamless integration with OpenAI Codex and Claude Code
- **Session Management**: Visualize and manage AI coding sessions with detailed history
- **Project Workspace**: File explorer and code editor integration for seamless development workflow
- **Token Usage Tracking**: Monitor and visualize token consumption across sessions
- **Real-time Updates**: Server-Sent Events (SSE) for live AI response streaming
- **Cross-platform**: Support for Windows, Linux, and macOS
- **System Tray**: Windows desktop application with tray icon support

## Screenshots

### System Tray
After launching OneCode.Win.exe, a system tray icon appears with the background service running automatically.

### Project Selection
Automatically scans and loads local projects that have used Codex, allowing you to select and enter a workspace.

### Session Management
- Start new conversations or select from session history
- Load previous sessions to restore full context
- View session details including token usage and timeline

### File Browser
Integrated file browser to view and edit code files directly while interacting with AI.

## Download & Installation

### Windows Desktop Application

1. Visit the [GitHub Releases](https://github.com/AIDotNet/OneCode/releases) page
2. Download the latest Windows archive (`OneCode-*-win-x64.zip`)
3. Extract and run `OneCode.Win.exe`
4. The program will display an icon in the system tray
5. Open your browser and visit `http://localhost:9110/`

### Linux

1. Download the latest Linux package (`OneCode-*-linux-x64.tar.gz`) from [Releases](https://github.com/AIDotNet/OneCode/releases)
2. Extract the archive:
   ```bash
   tar -xzf OneCode-*-linux-x64.tar.gz
   cd OneCode-*-linux-x64
   ```
3. Run directly:
   ```bash
   ./run.sh
   ```
4. Or install as a systemd service:
   ```bash
   sudo ./install-service.sh
   ```

### macOS

1. Download the latest macOS package (`OneCode-*-osx-x64.tar.gz`) from [Releases](https://github.com/AIDotNet/OneCode/releases)
2. Extract the archive:
   ```bash
   tar -xzf OneCode-*-osx-x64.tar.gz
   cd OneCode-*-osx-x64
   ```
3. Run directly:
   ```bash
   ./run.sh
   ```
4. Or install as a launch daemon:
   ```bash
   sudo ./install-service.sh
   ```

## Prerequisites

- **.NET 10.0 Runtime** (for standalone executables, it's self-contained)
- **Codex CLI** (required for Codex integration):
  ```bash
  npm install -g @openai/codex
  ```

## Usage

### Accessing OneCode

After starting the application, open your browser and navigate to:

- HTTP: `http://localhost:9110/`
- HTTPS: `https://localhost:9111/` (if configured)

### Project Workflow

1. **Select Project**: OneCode automatically scans for projects with Codex usage history
2. **Enter Workspace**: Click on a project to enter its workspace
3. **Start Conversation**: Begin a new chat or load a previous session
4. **View Code**: Use the integrated file browser to view and edit files
5. **Monitor Usage**: Track token usage and session statistics

### Session Management

- Click the session list button in the top-right corner
- Select a historical session
- Click "Load Session" to restore the complete context
- View session details including token usage, timeline, and metadata

## Development

### Backend (C# / ASP.NET Core)

```bash
# Build
dotnet build src/OneCode/OneCode.csproj

# Run (HTTP)
dotnet run --project src/OneCode/OneCode.csproj --launch-profile http

# Run (HTTPS)
dotnet run --project src/OneCode/OneCode.csproj --launch-profile https
```

### Frontend (React / Vite)

```bash
cd web

# Install dependencies
npm ci

# Development server
npm run dev

# Build for production
npm run build

# Lint code
npm run lint
```

### Build Full Application

The CI pipeline automatically builds both frontend and backend:

```bash
# Install frontend dependencies
npm ci

# Build frontend
npm run build

# Sync frontend to backend wwwroot
rsync -a --delete web/dist/ src/OneCode/wwwroot/

# Build backend
dotnet build src/OneCode/OneCode.csproj -c Release
```

## Architecture

OneCode follows a dual-stack architecture:

### Backend
- **Framework**: ASP.NET Core 10.0 Web API
- **Communication**: JSON-RPC over stdio with Codex app-server
- **Database**: SQLite with Entity Framework Core
- **Protocols**: Agent-to-Agent (A2A) protocol for streaming AI interactions

### Frontend
- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **State**: React Router + local component state
- **UI Components**: Radix UI with custom animations

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Community

- GitHub: [https://github.com/AIDotNet/OneCode](https://github.com/AIDotNet/OneCode)
- Issues: [https://github.com/AIDotNet/OneCode/issues](https://github.com/AIDotNet/OneCode/issues)
- Discussions: [https://github.com/AIDotNet/OneCode/discussions](https://github.com/AIDotNet/OneCode/discussions)

## Acknowledgments

- Inspired by [ZCode](https://zcode.dev/)
- Built with [OpenAI Codex](https://github.com/openai/codex) and [Anthropic Claude Code](https://claude.ai/code)

Community WeChat：wk28u9123456789
