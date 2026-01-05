import type { ToolStatusDto } from '@/api/types'

function formatPlatform(platform: string) {
  if (platform === 'windows') return 'Windows'
  if (platform === 'macos') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform || 'unknown'
}

function prereqLabel(installed: boolean, version: string | null) {
  if (!installed) return '未安装'
  return version ? `v${version}` : '已安装'
}

export function NodeInstallStatusCard({ status }: { status: ToolStatusDto }) {
  const nodeOk = status.nodeInstalled
  const npmOk = status.npmInstalled

  return (
    <div className="space-y-2 text-sm">
      <div>系统：{formatPlatform(status.platform)}</div>
      <div>Node.js：{prereqLabel(nodeOk, status.nodeVersion)}</div>
      <div>npm：{prereqLabel(npmOk, status.npmVersion)}</div>

      {!nodeOk || !npmOk ? (
        <div className="pt-2 text-xs text-muted-foreground">
          安装 Node.js 通常会同时安装 npm。安装完成后，可能需要重新打开终端/重启应用以刷新环境变量。
        </div>
      ) : (
        <div className="pt-2 text-xs text-muted-foreground">
          Node.js 与 npm 已就绪，可以继续安装 Codex/Claude Code。
        </div>
      )}
    </div>
  )
}

