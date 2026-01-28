/**
 * GitPanel - Git 源代码管理面板
 *
 * 显示 Git 仓库状态，支持暂存/取消暂存文件操作
 */

import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { api } from '@/api/client'
import type { GitStatusResponse, GitStatusEntryDto } from '@/api/types'
import {
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  File,
  FileEdit,
  FileX,
  FilePlus,
  FileQuestion,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  FolderGit2,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * GitPanel 组件属性
 */
export interface GitPanelProps {
  /** 工作区路径 */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
}

/**
 * Git 状态码映射到显示信息
 */
const STATUS_MAP: Record<string, { label: string; icon: typeof File; color: string }> = {
  'M': { label: '已修改', icon: FileEdit, color: 'text-yellow-500' },
  'A': { label: '已添加', icon: FilePlus, color: 'text-green-500' },
  'D': { label: '已删除', icon: FileX, color: 'text-red-500' },
  'R': { label: '已重命名', icon: FileEdit, color: 'text-blue-500' },
  'C': { label: '已复制', icon: FilePlus, color: 'text-blue-500' },
  '?': { label: '未跟踪', icon: FileQuestion, color: 'text-muted-foreground' },
  '!': { label: '已忽略', icon: File, color: 'text-muted-foreground' },
  ' ': { label: '', icon: File, color: 'text-muted-foreground' },
}

/**
 * 获取文件状态信息
 */
function getStatusInfo(status: string) {
  return STATUS_MAP[status] || STATUS_MAP[' ']
}

/**
 * 从路径中提取文件名
 */
function getFileName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}


/**
 * GitPanel 主组件
 */
export function GitPanel({ workspacePath, className }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stagedExpanded, setStagedExpanded] = useState(true)
  const [changesExpanded, setChangesExpanded] = useState(true)
  const [operatingFiles, setOperatingFiles] = useState<Set<string>>(new Set())

  // 获取 Git 状态
  const fetchStatus = useCallback(async () => {
    if (!workspacePath) return

    setLoading(true)
    setError(null)

    try {
      const result = await api.git.status(workspacePath)
      setStatus(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取 Git 状态失败'
      setError(message)
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  // 初始加载
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // 分离暂存和未暂存的文件
  const { stagedFiles, unstagedFiles } = categorizeFiles(status?.entries || [])

  // 暂存文件
  const handleStage = async (file: string) => {
    if (!workspacePath || operatingFiles.has(file)) return

    setOperatingFiles((prev) => new Set(prev).add(file))
    try {
      await api.git.stage({ path: workspacePath, file })
      await fetchStatus()
    } catch (err) {
      console.error('暂存文件失败:', err)
    } finally {
      setOperatingFiles((prev) => {
        const next = new Set(prev)
        next.delete(file)
        return next
      })
    }
  }

  // 取消暂存文件
  const handleUnstage = async (file: string) => {
    if (!workspacePath || operatingFiles.has(file)) return

    setOperatingFiles((prev) => new Set(prev).add(file))
    try {
      await api.git.unstage({ path: workspacePath, file })
      await fetchStatus()
    } catch (err) {
      console.error('取消暂存失败:', err)
    } finally {
      setOperatingFiles((prev) => {
        const next = new Set(prev)
        next.delete(file)
        return next
      })
    }
  }

  // 暂存所有文件
  const handleStageAll = async () => {
    if (!workspacePath || unstagedFiles.length === 0) return

    for (const entry of unstagedFiles) {
      await handleStage(entry.path)
    }
  }

  // 取消暂存所有文件
  const handleUnstageAll = async () => {
    if (!workspacePath || stagedFiles.length === 0) return

    for (const entry of stagedFiles) {
      await handleUnstage(entry.path)
    }
  }

  // 无工作区路径
  if (!workspacePath) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-4', className)}>
        <FolderGit2 className="w-12 h-12 text-muted-foreground/50 mb-4" />
        <p className="text-sm text-muted-foreground text-center">
          请先打开一个项目
        </p>
      </div>
    )
  }

  // 加载中
  if (loading && !status) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-4', className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">加载中...</p>
      </div>
    )
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-4', className)}>
        <AlertCircle className="w-8 h-8 text-destructive/70 mb-2" />
        <p className="text-sm text-muted-foreground text-center mb-4">{error}</p>
        <button
          onClick={fetchStatus}
          className="text-sm text-primary hover:underline"
        >
          重试
        </button>
      </div>
    )
  }


  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex flex-col h-full', className)}>
        {/* 头部：分支信息和刷新按钮 */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <GitBranch className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm font-medium truncate">
              {status?.branch || 'HEAD detached'}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={fetchStatus}
                disabled={loading}
                className={cn(
                  'p-1 rounded hover:bg-muted/50 transition-colors',
                  'text-muted-foreground hover:text-foreground',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">刷新</TooltipContent>
          </Tooltip>
        </div>

        {/* 文件列表 */}
        <div className="flex-1 overflow-auto">
          {/* 无变更 */}
          {stagedFiles.length === 0 && unstagedFiles.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full p-4">
              <p className="text-sm text-muted-foreground">没有文件变更</p>
            </div>
          )}

          {/* 暂存的更改 */}
          {stagedFiles.length > 0 && (
            <FileSection
              title="暂存的更改"
              count={stagedFiles.length}
              expanded={stagedExpanded}
              onToggle={() => setStagedExpanded(!stagedExpanded)}
              onAction={handleUnstageAll}
              actionIcon={Minus}
              actionTooltip="取消暂存所有"
            >
              {stagedFiles.map((entry) => (
                <FileItem
                  key={entry.path}
                  entry={entry}
                  statusType="index"
                  onAction={() => handleUnstage(entry.path)}
                  actionIcon={Minus}
                  actionTooltip="取消暂存"
                  isOperating={operatingFiles.has(entry.path)}
                />
              ))}
            </FileSection>
          )}

          {/* 未暂存的更改 */}
          {unstagedFiles.length > 0 && (
            <FileSection
              title="更改"
              count={unstagedFiles.length}
              expanded={changesExpanded}
              onToggle={() => setChangesExpanded(!changesExpanded)}
              onAction={handleStageAll}
              actionIcon={Plus}
              actionTooltip="暂存所有"
            >
              {unstagedFiles.map((entry) => (
                <FileItem
                  key={entry.path}
                  entry={entry}
                  statusType="worktree"
                  onAction={() => handleStage(entry.path)}
                  actionIcon={Plus}
                  actionTooltip="暂存"
                  isOperating={operatingFiles.has(entry.path)}
                />
              ))}
            </FileSection>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}


/**
 * 分类文件为暂存和未暂存
 */
function categorizeFiles(entries: GitStatusEntryDto[]) {
  const stagedFiles: GitStatusEntryDto[] = []
  const unstagedFiles: GitStatusEntryDto[] = []

  for (const entry of entries) {
    // 索引状态不为空格表示已暂存
    if (entry.indexStatus !== ' ' && entry.indexStatus !== '?') {
      stagedFiles.push(entry)
    }
    // 工作树状态不为空格或未跟踪文件
    if (entry.worktreeStatus !== ' ' || entry.indexStatus === '?') {
      unstagedFiles.push(entry)
    }
  }

  return { stagedFiles, unstagedFiles }
}

/**
 * FileSection 组件属性
 */
interface FileSectionProps {
  title: string
  count: number
  expanded: boolean
  onToggle: () => void
  onAction: () => void
  actionIcon: typeof Plus
  actionTooltip: string
  children: React.ReactNode
}

/**
 * FileSection - 文件分组组件
 */
function FileSection({
  title,
  count,
  expanded,
  onToggle,
  onAction,
  actionIcon: ActionIcon,
  actionTooltip,
  children,
}: FileSectionProps) {
  return (
    <div className="border-b border-border last:border-b-0">
      {/* 分组标题 */}
      <div
        className={cn(
          'flex items-center justify-between px-2 py-1.5',
          'hover:bg-muted/30 cursor-pointer select-none'
        )}
        onClick={onToggle}
      >
        <div className="flex items-center gap-1">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
          <span className="text-xs font-medium uppercase text-muted-foreground">
            {title}
          </span>
          <span className="text-xs text-muted-foreground/70 ml-1">
            {count}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onAction()
              }}
              className={cn(
                'p-0.5 rounded hover:bg-muted/50 transition-colors',
                'text-muted-foreground hover:text-foreground',
                'opacity-0 group-hover:opacity-100'
              )}
              style={{ opacity: 1 }}
            >
              <ActionIcon className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{actionTooltip}</TooltipContent>
        </Tooltip>
      </div>

      {/* 文件列表 */}
      {expanded && <div className="pb-1">{children}</div>}
    </div>
  )
}


/**
 * FileItem 组件属性
 */
interface FileItemProps {
  entry: GitStatusEntryDto
  statusType: 'index' | 'worktree'
  onAction: () => void
  actionIcon: typeof Plus
  actionTooltip: string
  isOperating: boolean
}

/**
 * FileItem - 单个文件项组件
 */
function FileItem({
  entry,
  statusType,
  onAction,
  actionIcon: ActionIcon,
  actionTooltip,
  isOperating,
}: FileItemProps) {
  const status = statusType === 'index' ? entry.indexStatus : entry.worktreeStatus
  // 对于未跟踪文件，使用 '?' 状态
  const displayStatus = entry.indexStatus === '?' ? '?' : status
  const statusInfo = getStatusInfo(displayStatus)
  const StatusIcon = statusInfo.icon
  const fileName = getFileName(entry.path)

  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-2 py-1 mx-1 rounded',
        'hover:bg-muted/50 cursor-pointer'
      )}
    >
      {/* 状态图标 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn('flex-shrink-0', statusInfo.color)}>
            <StatusIcon className="w-4 h-4" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="left">{statusInfo.label || '未知状态'}</TooltipContent>
      </Tooltip>

      {/* 文件名和路径 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm truncate">{fileName}</span>
          {entry.path !== fileName && (
            <span className="text-xs text-muted-foreground truncate">
              {entry.path}
            </span>
          )}
        </div>
      </div>

      {/* 状态标识 */}
      <span className={cn('text-xs font-mono flex-shrink-0', statusInfo.color)}>
        {displayStatus}
      </span>

      {/* 操作按钮 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAction()
            }}
            disabled={isOperating}
            className={cn(
              'p-0.5 rounded transition-colors flex-shrink-0',
              'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              'opacity-0 group-hover:opacity-100',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {isOperating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ActionIcon className="w-3.5 h-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{actionTooltip}</TooltipContent>
      </Tooltip>
    </div>
  )
}
