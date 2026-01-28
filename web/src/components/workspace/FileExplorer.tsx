import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { api } from '@/api/client'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { VirtualFileTree, type FsEntryTarget, getParentPath } from './VirtualFileTree'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Search, X, RefreshCw } from 'lucide-react'

// ============================================================================
// 工具函数
// ============================================================================

function splitFileSystemPath(path: string): string[] {
  const normalized = path.replace(/\//g, '\\').replace(/[\\]+$/, '')
  return normalized.split('\\').filter(Boolean)
}

function getRelativePath(fromPath: string, toPath: string): string | null {
  const fromParts = splitFileSystemPath(fromPath)
  const toParts = splitFileSystemPath(toPath)

  if (!fromParts.length || !toParts.length) return null

  const fromRoot = fromParts[0].toLowerCase()
  const toRoot = toParts[0].toLowerCase()
  if (fromRoot !== toRoot) return null

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common].toLowerCase() === toParts[common].toLowerCase()
  ) {
    common += 1
  }

  const up = new Array(Math.max(0, fromParts.length - common)).fill('..')
  const down = toParts.slice(common)
  const combined = [...up, ...down]
  return combined.join('\\') || '.'
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall back
    }
  }

  try {
    if (typeof document === 'undefined') return false
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

// ============================================================================
// 右键上下文菜单组件
// ============================================================================

function FsContextMenu({
  open,
  x,
  y,
  onClose,
  children,
}: {
  open: boolean
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    const onScroll = () => onClose()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onClose])

  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
      role="presentation"
    >
      <div
        className="fixed min-w-[200px] max-w-[280px] max-h-[calc(100vh-16px)] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}


// ============================================================================
// FileExplorer 组件属性
// ============================================================================

export interface FileExplorerProps {
  /** 工作区路径 */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
}

// ============================================================================
// FileExplorer 组件
// ============================================================================

/**
 * FileExplorer - 文件资源管理器组件
 *
 * 显示项目文件树，支持：
 * - 树形结构显示文件和文件夹
 * - 文件夹展开/折叠
 * - VS Code 风格文件图标
 * - 文件搜索过滤
 * - 右键上下文菜单
 */
export function FileExplorer({ workspacePath, className }: FileExplorerProps) {
  const openFile = useWorkspaceStore((state) => state.openFile)
  
  // 搜索过滤状态
  const [filterKeyword, setFilterKeyword] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  
  // 通知消息状态
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    target: FsEntryTarget
  } | null>(null)
  
  // 刷新状态
  const [refreshKey, setRefreshKey] = useState(0)

  // 显示通知
  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (typeof window === 'undefined') return

    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current)
    }

    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null)
      noticeTimerRef.current = null
    }, 1800)
  }, [])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current)
      }
    }
  }, [])

  // 聚焦搜索框
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [showSearch])

  // 处理文件点击
  const handleFileClick = useCallback(
    (path: string) => {
      openFile(path)
    },
    [openFile],
  )

  // 打开右键菜单
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, target: FsEntryTarget) => {
      e.preventDefault()
      e.stopPropagation()
      if (typeof window === 'undefined') return

      const menuWidth = 200
      const menuHeight = 320
      const x = Math.min(e.clientX, Math.max(0, window.innerWidth - menuWidth))
      const y = Math.min(e.clientY, Math.max(0, window.innerHeight - menuHeight))
      setContextMenu({ x, y, target })
    },
    [],
  )

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  // 复制绝对路径
  const handleCopyPath = useCallback(
    async (path: string) => {
      const ok = await copyTextToClipboard(path)
      showNotice(ok ? '已复制绝对路径' : '复制失败')
    },
    [showNotice],
  )

  // 复制相对路径
  const handleCopyRelativePath = useCallback(
    async (path: string) => {
      const root = workspacePath?.trim()
      if (!root) {
        await handleCopyPath(path)
        return
      }

      const relative = getRelativePath(root, path)
      if (!relative) {
        await handleCopyPath(path)
        return
      }

      const ok = await copyTextToClipboard(relative)
      showNotice(ok ? '已复制相对路径' : '复制失败')
    },
    [handleCopyPath, showNotice, workspacePath],
  )

  // 复制名称
  const handleCopyName = useCallback(
    async (name: string) => {
      const ok = await copyTextToClipboard(name)
      showNotice(ok ? '已复制名称' : '复制失败')
    },
    [showNotice],
  )

  // 在资源管理器中显示
  const handleRevealInExplorer = useCallback(
    async (path: string) => {
      try {
        await api.fs.revealInExplorer(path)
      } catch (e) {
        showNotice((e as Error).message)
      }
    },
    [showNotice],
  )

  // 在终端中打开
  const handleOpenTerminal = useCallback(
    async (path: string) => {
      try {
        await api.fs.openTerminal(path)
      } catch (e) {
        showNotice((e as Error).message)
      }
    },
    [showNotice],
  )

  // 刷新文件树
  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1)
    showNotice('已刷新')
  }, [showNotice])

  // 切换搜索框显示
  const toggleSearch = useCallback(() => {
    setShowSearch((s) => {
      if (s) {
        setFilterKeyword('')
      }
      return !s
    })
  }, [])

  // 清除搜索
  const clearSearch = useCallback(() => {
    setFilterKeyword('')
    setShowSearch(false)
  }, [])

  if (!workspacePath) {
    return (
      <div className={cn('flex items-center justify-center h-full text-sm text-muted-foreground', className)}>
        未打开工作区
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50">
        <button
          onClick={toggleSearch}
          className={cn(
            'p-1 rounded hover:bg-muted/50 transition-colors',
            showSearch && 'bg-muted/50'
          )}
          title="搜索文件 (Ctrl+F)"
        >
          <Search className="w-4 h-4 text-muted-foreground" />
        </button>
        <button
          onClick={handleRefresh}
          className="p-1 rounded hover:bg-muted/50 transition-colors"
          title="刷新"
        >
          <RefreshCw className="w-4 h-4 text-muted-foreground" />
        </button>
        
        {/* 通知消息 */}
        {notice && (
          <span className="ml-auto text-xs text-muted-foreground animate-in fade-in duration-200">
            {notice}
          </span>
        )}
      </div>

      {/* 搜索框 */}
      {showSearch && (
        <div className="px-2 py-1.5 border-b border-border/50">
          <div className="relative">
            <Input
              ref={searchInputRef}
              value={filterKeyword}
              onChange={(e) => setFilterKeyword(e.target.value)}
              placeholder="搜索文件..."
              className="h-7 text-sm pr-7"
            />
            {filterKeyword && (
              <button
                onClick={clearSearch}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted/50"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 文件树 - 使用虚拟滚动优化性能 */}
      <div className="flex-1 overflow-hidden">
        <VirtualFileTree
          key={refreshKey}
          workspacePath={workspacePath}
          filterKeyword={filterKeyword}
          onFileClick={handleFileClick}
          onContextMenu={handleContextMenu}
        />
      </div>

      {/* 右键上下文菜单 */}
      <FsContextMenu
        open={Boolean(contextMenu)}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        onClose={closeContextMenu}
      >
        <div className="p-1">
          {/* 目标名称 */}
          <div className="px-2 py-1 text-xs text-muted-foreground truncate">
            {contextMenu?.target.name}
          </div>
          <Separator className="my-1" />
          
          {/* 打开操作 */}
          {contextMenu?.target.kind === 'file' && (
            <button
              type="button"
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                if (contextMenu?.target) {
                  handleFileClick(contextMenu.target.fullPath)
                }
                closeContextMenu()
              }}
            >
              打开文件
            </button>
          )}
          
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              if (contextMenu?.target) {
                void handleRevealInExplorer(contextMenu.target.fullPath)
              }
              closeContextMenu()
            }}
          >
            {contextMenu?.target.kind === 'directory' ? '在资源管理器中打开' : '在资源管理器中显示'}
          </button>
          
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              if (contextMenu?.target) {
                const path =
                  contextMenu.target.kind === 'file'
                    ? getParentPath(contextMenu.target.fullPath) ?? contextMenu.target.fullPath
                    : contextMenu.target.fullPath
                void handleOpenTerminal(path)
              }
              closeContextMenu()
            }}
          >
            在终端打开
          </button>
          
          <Separator className="my-1" />
          
          {/* 复制操作 */}
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              if (contextMenu?.target) {
                void handleCopyPath(contextMenu.target.fullPath)
              }
              closeContextMenu()
            }}
          >
            复制绝对路径
          </button>
          
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              if (contextMenu?.target) {
                void handleCopyRelativePath(contextMenu.target.fullPath)
              }
              closeContextMenu()
            }}
          >
            复制相对路径
          </button>
          
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              if (contextMenu?.target) {
                void handleCopyName(contextMenu.target.name)
              }
              closeContextMenu()
            }}
          >
            {contextMenu?.target.kind === 'directory' ? '复制文件夹名' : '复制文件名'}
          </button>
        </div>
      </FsContextMenu>
    </div>
  )
}
