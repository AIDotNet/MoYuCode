import type { ProjectDto, ToolStatusDto } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Plus, Search } from 'lucide-react'

export function ProjectSelectionCard({
  projects,
  scanning,
  scanLogs,
  codexStatus,
  onSelectProject,
  onCreateProject,
  onScanProjects,
  onStopScan,
  onGoInstallCodex,
}: {
  projects: ProjectDto[]
  scanning: boolean
  scanLogs: string[]
  codexStatus: ToolStatusDto | null
  onSelectProject: (id: string) => void
  onCreateProject: () => void
  onScanProjects: () => void
  onStopScan: () => void
  onGoInstallCodex: () => void
}) {
  const codexInstalled = codexStatus ? codexStatus.installed : null

  return (
    <div className="rounded-lg border bg-card p-4 animate-in fade-in-0 duration-200">
      <div className="text-sm font-medium">先选择一个项目</div>
      <div className="mt-1 text-xs text-muted-foreground">
        选择后会打开工作区，并将路由固定为{' '}
        <code className="px-1">/code?projects=id</code>。
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCreateProject}>
          <Plus className="size-4" />
          新建项目
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={scanning || codexInstalled === false}
          onClick={onScanProjects}
          title="扫描 Codex sessions 并创建项目"
        >
          {scanning ? (
            <span className="inline-flex items-center gap-2">
              <Spinner /> 扫描中
            </span>
          ) : (
            <>
              <Search className="size-4" />
              扫描项目
            </>
          )}
        </Button>

        {codexStatus?.version ? (
          <div className="ml-auto text-xs text-muted-foreground">
            Codex v{codexStatus.version}
          </div>
        ) : null}
      </div>

      {codexInstalled === false ? (
        <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="font-medium">未检测到 Codex</div>
          <div className="mt-1 text-xs text-muted-foreground">
            扫描前会执行 <code className="px-1">codex -V</code>；请先安装 Codex CLI。
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onGoInstallCodex}>
              前往安装
            </Button>
          </div>
        </div>
      ) : null}

      {!projects.length ? (
        <div className="mt-4 space-y-3">
          <div className="text-sm text-muted-foreground">
            {scanning ? '正在自动扫描项目…' : '暂无项目。'}
          </div>
          {scanLogs.length ? (
            <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
              {scanLogs.join('\n')}
            </pre>
          ) : null}
          {scanning ? (
            <Button type="button" variant="outline" onClick={onStopScan}>
              停止扫描
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cn(
                'rounded-md border bg-background p-3 text-left',
                'transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out',
                'hover:bg-accent/40 hover:border-border hover:shadow-sm',
                'active:scale-[0.99]',
              )}
              onClick={() => onSelectProject(p.id)}
            >
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {p.workspacePath}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

