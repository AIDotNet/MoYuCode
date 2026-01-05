import { cn } from '@/lib/utils'

function CommandBlock({ children }: { children: string }) {
  return (
    <pre
      className={cn(
        'mt-2 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs',
      )}
    >
      {children}
    </pre>
  )
}

export function NodeInstallInstructionsCard({ platform }: { platform: string }) {
  const downloadUrl = 'https://nodejs.org/en/download'

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-sm font-medium">手动安装指引</div>
      <div className="mt-1 text-xs text-muted-foreground">
        优先推荐使用系统包管理器；如果不可用，可使用官方安装包。
      </div>

      {platform === 'windows' ? (
        <div className="mt-3 text-sm">
          <div className="font-medium">Windows</div>
          <div className="mt-1 text-xs text-muted-foreground">
            使用 winget（需要 App Installer）：
          </div>
          <CommandBlock>
            winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements
            --accept-source-agreements --silent
          </CommandBlock>
          <div className="mt-2 text-xs text-muted-foreground">
            或手动下载：{' '}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              {downloadUrl}
            </a>
          </div>
        </div>
      ) : null}

      {platform === 'macos' ? (
        <div className="mt-3 text-sm">
          <div className="font-medium">macOS</div>
          <div className="mt-1 text-xs text-muted-foreground">使用 Homebrew：</div>
          <CommandBlock>brew install node</CommandBlock>
          <div className="mt-2 text-xs text-muted-foreground">
            或手动下载：{' '}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              {downloadUrl}
            </a>
          </div>
        </div>
      ) : null}

      {platform === 'linux' ? (
        <div className="mt-3 text-sm">
          <div className="font-medium">Linux</div>
          <div className="mt-1 text-xs text-muted-foreground">
            不同发行版命令不同（以下为常见示例）：
          </div>
          <CommandBlock>
            # Debian/Ubuntu
            sudo apt-get update && sudo apt-get install -y nodejs npm

            # Fedora
            sudo dnf install -y nodejs npm

            # RHEL/CentOS
            sudo yum install -y nodejs npm

            # Arch
            sudo pacman -Sy --noconfirm nodejs npm

            # Alpine
            sudo apk add nodejs npm
          </CommandBlock>
          <div className="mt-2 text-xs text-muted-foreground">
            或手动下载：{' '}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              {downloadUrl}
            </a>
          </div>
        </div>
      ) : null}

      {platform !== 'windows' && platform !== 'macos' && platform !== 'linux' ? (
        <div className="mt-3 text-sm">
          <div className="font-medium">通用</div>
          <div className="mt-1 text-xs text-muted-foreground">
            请安装 Node.js（包含 npm）：
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              {downloadUrl}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  )
}

