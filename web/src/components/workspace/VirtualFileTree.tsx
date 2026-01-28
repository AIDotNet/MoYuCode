import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '@/api/client'
import type { DirectoryEntryDto, FileEntryDto, ListEntriesResponse } from '@/api/types'
import { getVscodeFileIconUrl, getVscodeFolderIconUrls } from '@/lib/vscodeFileIcons'
import { cn } from '@/lib/utils'
import { ChevronRight, ChevronDown } from 'lucide-react'

// ============================================================================
// 类型定义
// ============================================================================

export type FsEntryKind = 'file' | 'directory'

export interface FsEntryTarget {
  kind: FsEntryKind
  name: string
  fullPath: string
}

/** 扁平化的树节点 */
interface FlatTreeNode {
  id: string
  kind: FsEntryKind
  name: string
  fullPath: string
  depth: number
  isExpanded?: boolean
  isLoading?: boolean
  hasError?: boolean
  errorMessage?: string
  hasChildren?: boolean
}

// ============================================================================
// 工具函数
// ============================================================================

export function normalizePathForComparison(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

export function getParentPath(fullPath: string): string | null {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return null

  const parent = normalized.slice(0, lastSeparator)
  if (!parent) return null
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`
  return parent
}

export function getBaseName(fullPath: string): string {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return normalized
  const base = normalized.slice(lastSeparator + 1)
  return base || normalized
}


// ============================================================================
// VirtualFileTree 组件属性
// ============================================================================

export interface VirtualFileTreeProps {
  /** 工作区根路径 */
  workspacePath: string
  /** 文件点击回调 */
  onFileClick?: (path: string) => void
  /** 右键菜单回调 */
  onContextMenu?: (e: ReactMouseEvent, target: FsEntryTarget) => void
  /** 自定义类名 */
  className?: string
  /** 文件搜索过滤关键词 */
  filterKeyword?: string
}

// ============================================================================
// VirtualFileTree 组件
// ============================================================================

/**
 * VirtualFileTree - 虚拟滚动文件树组件
 *
 * 使用虚拟滚动优化大量文件的渲染性能，支持：
 * - 懒加载文件夹内容
 * - VS Code 风格文件图标
 * - 展开/折叠目录
 * - 右键上下文菜单
 * - 文件搜索过滤
 */
export function VirtualFileTree({
  workspacePath,
  onFileClick,
  onContextMenu,
  className,
  filterKeyword,
}: VirtualFileTreeProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const inFlightRef = useRef<Set<string>>(new Set())
  
  // 存储每个路径的子条目
  const [entriesByPath, setEntriesByPath] = useState<
    Record<string, Pick<ListEntriesResponse, 'directories' | 'files'>>
  >({})
  const entriesByPathRef = useRef(entriesByPath)
  
  // 展开状态
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  
  // 加载和错误状态
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [errorByPath, setErrorByPath] = useState<Record<string, string>>({})

  useEffect(() => {
    entriesByPathRef.current = entriesByPath
  }, [entriesByPath])


  // 重置所有条目
  const resetEntries = useCallback(() => {
    inFlightRef.current.clear()
    setEntriesByPath({})
    entriesByPathRef.current = {}
    setExpandedPaths(new Set())
    setLoadingPaths(new Set())
    setErrorByPath({})
  }, [])

  // 加载目录内容
  const loadEntries = useCallback(async (path: string) => {
    const normalizedPath = path.trim()
    if (!normalizedPath) return
    if (entriesByPathRef.current[normalizedPath]) return
    if (inFlightRef.current.has(normalizedPath)) return

    inFlightRef.current.add(normalizedPath)
    setLoadingPaths((s) => new Set(s).add(normalizedPath))
    setErrorByPath((s) => {
      const next = { ...s }
      delete next[normalizedPath]
      return next
    })

    try {
      const data = await api.fs.listEntries(normalizedPath)
      setEntriesByPath((s) => {
        const next = {
          ...s,
          [normalizedPath]: { directories: data.directories, files: data.files },
          [data.currentPath]: { directories: data.directories, files: data.files },
        }
        entriesByPathRef.current = next
        return next
      })
    } catch (e) {
      setErrorByPath((s) => ({ ...s, [normalizedPath]: (e as Error).message }))
    } finally {
      inFlightRef.current.delete(normalizedPath)
      setLoadingPaths((s) => {
        const next = new Set(s)
        next.delete(normalizedPath)
        return next
      })
    }
  }, [])

  // 切换目录展开状态
  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((s) => {
      const next = new Set(s)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        // 加载内容
        void loadEntries(path)
      }
      return next
    })
  }, [loadEntries])

  // 初始化加载根目录
  useEffect(() => {
    resetEntries()
    const rootPath = workspacePath.trim()
    if (!rootPath) return
    void loadEntries(rootPath)
    setExpandedPaths(new Set([rootPath]))
  }, [loadEntries, resetEntries, workspacePath])


  // 过滤条目
  const filterEntries = useCallback(
    (
      directories: DirectoryEntryDto[],
      files: FileEntryDto[],
    ): { directories: DirectoryEntryDto[]; files: FileEntryDto[] } => {
      if (!filterKeyword?.trim()) {
        return { directories, files }
      }
      const keyword = filterKeyword.toLowerCase().trim()
      return {
        directories: directories.filter((d) => d.name.toLowerCase().includes(keyword)),
        files: files.filter((f) => f.name.toLowerCase().includes(keyword)),
      }
    },
    [filterKeyword],
  )

  // 构建扁平化的树节点列表
  const flatNodes = useMemo((): FlatTreeNode[] => {
    const nodes: FlatTreeNode[] = []
    const rootPath = workspacePath.trim()
    if (!rootPath) return nodes

    const buildNodes = (path: string, depth: number) => {
      const entries = entriesByPath[path]
      const isLoading = loadingPaths.has(path)
      const error = errorByPath[path]

      if (error) {
        nodes.push({
          id: `error-${path}`,
          kind: 'file',
          name: error,
          fullPath: path,
          depth,
          hasError: true,
          errorMessage: error,
        })
        return
      }

      if (isLoading && !entries) {
        nodes.push({
          id: `loading-${path}`,
          kind: 'file',
          name: '加载中…',
          fullPath: path,
          depth,
          isLoading: true,
        })
        return
      }

      if (!entries) return

      const filtered = filterEntries(entries.directories, entries.files)

      // 添加目录
      for (const dir of filtered.directories) {
        const isExpanded = expandedPaths.has(dir.fullPath)
        nodes.push({
          id: dir.fullPath,
          kind: 'directory',
          name: dir.name,
          fullPath: dir.fullPath,
          depth,
          isExpanded,
          hasChildren: true,
        })

        if (isExpanded) {
          buildNodes(dir.fullPath, depth + 1)
        }
      }

      // 添加文件
      for (const file of filtered.files) {
        nodes.push({
          id: file.fullPath,
          kind: 'file',
          name: file.name,
          fullPath: file.fullPath,
          depth,
        })
      }
    }

    buildNodes(rootPath, 0)
    return nodes
  }, [workspacePath, entriesByPath, expandedPaths, loadingPaths, errorByPath, filterEntries])


  // 虚拟滚动
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24, // 每行高度约 24px
    overscan: 10, // 预渲染额外的行数
  })

  // 渲染单个节点
  const renderNode = useCallback(
    (node: FlatTreeNode, style: React.CSSProperties) => {
      const paddingLeft = 8 + node.depth * 16

      // 加载中状态
      if (node.isLoading) {
        return (
          <div
            key={node.id}
            style={style}
            className="flex items-center text-sm text-muted-foreground"
          >
            <span style={{ paddingLeft }}>加载中…</span>
          </div>
        )
      }

      // 错误状态
      if (node.hasError) {
        return (
          <div
            key={node.id}
            style={style}
            className="flex items-center text-sm text-destructive"
          >
            <span style={{ paddingLeft }}>{node.errorMessage}</span>
          </div>
        )
      }

      // 目录节点
      if (node.kind === 'directory') {
        const icons = getVscodeFolderIconUrls(node.name)
        const iconUrl = node.isExpanded ? icons.open : icons.closed

        return (
          <div
            key={node.id}
            style={style}
            className={cn(
              'flex items-center gap-1 text-sm cursor-pointer select-none',
              'hover:bg-muted/50 transition-colors'
            )}
            onClick={() => toggleExpand(node.fullPath)}
            onContextMenu={(e) =>
              onContextMenu?.(e, { kind: 'directory', name: node.name, fullPath: node.fullPath })
            }
          >
            <span style={{ paddingLeft: paddingLeft - 16 }} className="flex items-center">
              {node.isExpanded ? (
                <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
              )}
            </span>
            {iconUrl && (
              <img
                src={iconUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="w-4 h-4 shrink-0"
              />
            )}
            <span className="truncate">{node.name}</span>
          </div>
        )
      }

      // 文件节点
      const iconUrl = getVscodeFileIconUrl(node.name)

      return (
        <div
          key={node.id}
          style={style}
          className={cn(
            'flex items-center gap-1 text-sm cursor-pointer select-none',
            'hover:bg-muted/50 transition-colors'
          )}
          onClick={() => onFileClick?.(node.fullPath)}
          onDoubleClick={() => onFileClick?.(node.fullPath)}
          onContextMenu={(e) =>
            onContextMenu?.(e, { kind: 'file', name: node.name, fullPath: node.fullPath })
          }
        >
          <span style={{ paddingLeft }} className="flex items-center gap-1">
            {iconUrl && (
              <img
                src={iconUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="w-4 h-4 shrink-0"
              />
            )}
            <span className="truncate">{node.name}</span>
          </span>
        </div>
      )
    },
    [toggleExpand, onFileClick, onContextMenu],
  )


  // 空状态
  const rootPath = workspacePath.trim()
  if (!rootPath) {
    return (
      <div className={cn('h-full flex items-center justify-center', className)}>
        <span className="text-sm text-muted-foreground">未设置工作空间</span>
      </div>
    )
  }

  if (flatNodes.length === 0) {
    const isLoading = loadingPaths.has(rootPath)
    const error = errorByPath[rootPath]

    if (error) {
      return (
        <div className={cn('h-full flex items-center justify-center', className)}>
          <span className="text-sm text-destructive">{error}</span>
        </div>
      )
    }

    if (isLoading) {
      return (
        <div className={cn('h-full flex items-center justify-center', className)}>
          <span className="text-sm text-muted-foreground">加载中…</span>
        </div>
      )
    }

    return (
      <div className={cn('h-full flex items-center justify-center', className)}>
        <span className="text-sm text-muted-foreground">
          {filterKeyword?.trim() ? '没有匹配的文件' : '暂无文件'}
        </span>
      </div>
    )
  }

  return (
    <div
      ref={parentRef}
      className={cn('h-full overflow-auto', className)}
      onContextMenu={(e) => {
        if (!rootPath) return
        onContextMenu?.(e, {
          kind: 'directory',
          name: getBaseName(rootPath),
          fullPath: rootPath,
        })
      }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const node = flatNodes[virtualItem.index]
          return renderNode(node, {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${virtualItem.size}px`,
            transform: `translateY(${virtualItem.start}px)`,
          })
        })}
      </div>
    </div>
  )
}

// 导出刷新函数的 hook
export function useVirtualFileTreeRefresh() {
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  return { refreshKey, refresh }
}
