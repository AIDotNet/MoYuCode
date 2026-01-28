import { cn } from '@/lib/utils'
import { Search, FileCode, Clock, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useWorkspaceStore, type FileIndexEntry } from '@/stores/workspaceStore'
import { api } from '@/api/client'
import { getVscodeFileIconUrl } from '@/lib/vscodeFileIcons'

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 快速打开项类型
 */
export interface QuickOpenItem {
  /** 项目类型 */
  type: 'file' | 'recent'
  /** 显示标签（文件名） */
  label: string
  /** 描述信息（相对路径） */
  description?: string
  /** 文件完整路径 */
  path: string
  /** 匹配分数（用于排序） */
  score?: number
  /** 匹配位置（用于高亮） */
  matches?: number[]
}

/**
 * QuickOpen 组件属性
 */
export interface QuickOpenProps {
  /** 工作区路径 */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
}

// ============================================================================
// 模糊匹配算法
// ============================================================================

/**
 * 模糊匹配结果
 */
interface FuzzyMatchResult {
  /** 是否匹配 */
  matched: boolean
  /** 匹配分数（越高越好） */
  score: number
  /** 匹配字符的位置索引 */
  matches: number[]
}

/**
 * 模糊匹配算法
 * 
 * 实现类似 VS Code 的模糊匹配：
 * - 支持非连续字符匹配
 * - 连续匹配得分更高
 * - 单词开头匹配得分更高
 * - 大小写不敏感
 */
function fuzzyMatch(pattern: string, text: string): FuzzyMatchResult {
  if (!pattern) {
    return { matched: true, score: 0, matches: [] }
  }

  const patternLower = pattern.toLowerCase()
  const textLower = text.toLowerCase()
  const patternLen = patternLower.length
  const textLen = textLower.length

  if (patternLen > textLen) {
    return { matched: false, score: 0, matches: [] }
  }

  const matches: number[] = []
  let patternIdx = 0
  let score = 0
  let lastMatchIdx = -1
  let consecutiveBonus = 0

  for (let textIdx = 0; textIdx < textLen && patternIdx < patternLen; textIdx++) {
    if (textLower[textIdx] === patternLower[patternIdx]) {
      matches.push(textIdx)
      
      // 基础分数
      score += 1

      // 连续匹配奖励
      if (lastMatchIdx === textIdx - 1) {
        consecutiveBonus += 2
        score += consecutiveBonus
      } else {
        consecutiveBonus = 0
      }

      // 单词开头奖励（首字符或前一个字符是分隔符）
      if (textIdx === 0 || /[/\\._\-\s]/.test(text[textIdx - 1])) {
        score += 5
      }

      // 大小写完全匹配奖励
      if (pattern[patternIdx] === text[textIdx]) {
        score += 1
      }

      lastMatchIdx = textIdx
      patternIdx++
    }
  }

  const matched = patternIdx === patternLen

  // 如果匹配成功，根据匹配紧凑度调整分数
  if (matched && matches.length > 0) {
    const span = matches[matches.length - 1] - matches[0] + 1
    const compactness = matches.length / span
    score += Math.floor(compactness * 10)

    // 文件名越短，分数越高（更精确的匹配）
    score += Math.max(0, 20 - textLen)
  }

  return { matched, score, matches }
}

/**
 * 获取文件名（不含路径）
 */
function getFileName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/**
 * 获取相对路径的目录部分
 */
function getDirectory(relativePath: string): string {
  const parts = relativePath.split(/[/\\]/)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}


// ============================================================================
// 文件索引构建
// ============================================================================

/**
 * 递归获取目录下所有文件
 */
async function collectFilesRecursively(
  dirPath: string,
  workspacePath: string,
  maxDepth: number = 10,
  currentDepth: number = 0
): Promise<FileIndexEntry[]> {
  if (currentDepth >= maxDepth) return []

  try {
    const response = await api.fs.listEntries(dirPath)
    const entries: FileIndexEntry[] = []

    // 添加当前目录的文件
    for (const file of response.files) {
      const relativePath = file.fullPath
        .replace(workspacePath, '')
        .replace(/^[/\\]+/, '')
      entries.push({
        name: file.name,
        fullPath: file.fullPath,
        relativePath,
      })
    }

    // 递归处理子目录（排除常见的忽略目录）
    const ignoreDirs = new Set([
      'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 
      'out', 'bin', 'obj', '.next', '.nuxt', 'coverage',
      '__pycache__', '.pytest_cache', 'venv', '.venv',
    ])

    for (const dir of response.directories) {
      if (ignoreDirs.has(dir.name.toLowerCase())) continue
      if (dir.name.startsWith('.') && dir.name !== '.kiro') continue

      const subEntries = await collectFilesRecursively(
        dir.fullPath,
        workspacePath,
        maxDepth,
        currentDepth + 1
      )
      entries.push(...subEntries)
    }

    return entries
  } catch {
    return []
  }
}

// ============================================================================
// 高亮文本组件
// ============================================================================

/**
 * 高亮匹配字符的文本组件
 */
function HighlightedText({ 
  text, 
  matches,
  className,
}: { 
  text: string
  matches?: number[]
  className?: string
}) {
  if (!matches || matches.length === 0) {
    return <span className={className}>{text}</span>
  }

  const matchSet = new Set(matches)
  const parts: { text: string; highlight: boolean }[] = []
  let currentPart = ''
  let currentHighlight = false

  for (let i = 0; i < text.length; i++) {
    const isMatch = matchSet.has(i)
    if (isMatch !== currentHighlight) {
      if (currentPart) {
        parts.push({ text: currentPart, highlight: currentHighlight })
      }
      currentPart = text[i]
      currentHighlight = isMatch
    } else {
      currentPart += text[i]
    }
  }
  if (currentPart) {
    parts.push({ text: currentPart, highlight: currentHighlight })
  }

  return (
    <span className={className}>
      {parts.map((part, idx) => (
        part.highlight ? (
          <span key={idx} className="text-primary font-medium">{part.text}</span>
        ) : (
          <span key={idx}>{part.text}</span>
        )
      ))}
    </span>
  )
}


// ============================================================================
// QuickOpenContent 组件
// ============================================================================

interface QuickOpenContentProps {
  className?: string
  workspacePath?: string
  onClose: () => void
  onOpenFile: (path: string, title?: string) => void
}

function QuickOpenContent({ 
  className, 
  workspacePath,
  onClose,
  onOpenFile,
}: QuickOpenContentProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  
  // 从 store 获取状态
  const recentFiles = useWorkspaceStore((state) => state.recentFiles)
  const fileIndex = useWorkspaceStore((state) => state.fileIndex)
  const fileIndexLoading = useWorkspaceStore((state) => state.fileIndexLoading)
  const setFileIndex = useWorkspaceStore((state) => state.setFileIndex)
  const setFileIndexLoading = useWorkspaceStore((state) => state.setFileIndexLoading)

  // 加载文件索引
  useEffect(() => {
    if (!workspacePath || fileIndex.length > 0) return

    let cancelled = false
    setFileIndexLoading(true)

    collectFilesRecursively(workspacePath, workspacePath)
      .then((entries) => {
        if (!cancelled) {
          setFileIndex(entries)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFileIndexLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [workspacePath, fileIndex.length, setFileIndex, setFileIndexLoading])

  // 聚焦输入框
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }, [])


  // 计算过滤后的结果
  const filteredItems = useMemo((): QuickOpenItem[] => {
    const trimmedQuery = query.trim()

    // 如果没有查询，显示最近文件
    if (!trimmedQuery) {
      return recentFiles.slice(0, 10).map((path) => ({
        type: 'recent' as const,
        label: getFileName(path),
        description: getDirectory(path.replace(workspacePath || '', '').replace(/^[/\\]+/, '')),
        path,
        score: 0,
        matches: [],
      }))
    }

    // 对文件索引进行模糊匹配
    const results: QuickOpenItem[] = []

    for (const entry of fileIndex) {
      // 同时匹配文件名和相对路径
      const nameMatch = fuzzyMatch(trimmedQuery, entry.name)
      const pathMatch = fuzzyMatch(trimmedQuery, entry.relativePath)

      // 取较好的匹配结果
      const bestMatch = nameMatch.score >= pathMatch.score ? nameMatch : pathMatch
      const isNameMatch = nameMatch.score >= pathMatch.score

      if (bestMatch.matched) {
        results.push({
          type: 'file',
          label: entry.name,
          description: getDirectory(entry.relativePath),
          path: entry.fullPath,
          score: bestMatch.score,
          matches: isNameMatch ? bestMatch.matches : [],
        })
      }
    }

    // 按分数排序，分数相同则按文件名长度排序
    results.sort((a, b) => {
      if (b.score !== a.score) return (b.score || 0) - (a.score || 0)
      return a.label.length - b.label.length
    })

    // 最多返回 50 个结果
    return results.slice(0, 50)
  }, [query, fileIndex, recentFiles, workspacePath])

  // 重置选中索引
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])


  // 滚动选中项到可见区域
  useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // 处理选择项目
  const handleSelect = useCallback((item: QuickOpenItem) => {
    onOpenFile(item.path, item.label)
    onClose()
  }, [onOpenFile, onClose])

  // 处理键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((prev) =>
          prev < filteredItems.length - 1 ? prev + 1 : prev
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
        break
      case 'Enter':
        e.preventDefault()
        if (filteredItems[selectedIndex]) {
          handleSelect(filteredItems[selectedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
      case 'Home':
        e.preventDefault()
        setSelectedIndex(0)
        break
      case 'End':
        e.preventDefault()
        setSelectedIndex(Math.max(0, filteredItems.length - 1))
        break
      case 'PageDown':
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 10, filteredItems.length - 1))
        break
      case 'PageUp':
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 10, 0))
        break
    }
  }, [filteredItems, selectedIndex, handleSelect, onClose])


  // 获取文件图标
  const getFileIcon = useCallback((item: QuickOpenItem) => {
    const iconUrl = getVscodeFileIconUrl(item.label)
    if (iconUrl) {
      return (
        <img 
          src={iconUrl} 
          alt="" 
          className="w-4 h-4 shrink-0" 
          draggable={false}
        />
      )
    }
    if (item.type === 'recent') {
      return <Clock className="w-4 h-4 shrink-0 text-muted-foreground" />
    }
    return <FileCode className="w-4 h-4 shrink-0 text-muted-foreground" />
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/50" />

      {/* 弹窗内容 */}
      <div
        className={cn(
          'relative w-full max-w-xl bg-background border border-border rounded-lg shadow-2xl overflow-hidden',
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索输入框 */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入文件名搜索..."
            className={cn(
              'flex-1 bg-transparent text-sm',
              'focus:outline-none',
              'placeholder:text-muted-foreground/60'
            )}
          />
          {fileIndexLoading && (
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
          )}
        </div>


        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[300px] overflow-auto">
          {/* 显示分类标题 */}
          {!query.trim() && filteredItems.length > 0 && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground/60 bg-muted/30">
              最近打开
            </div>
          )}

          {filteredItems.length > 0 ? (
            filteredItems.map((item, index) => (
              <div
                key={item.path}
                data-index={index}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 cursor-pointer',
                  'transition-colors duration-100',
                  index === selectedIndex
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50'
                )}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {getFileIcon(item)}
                <HighlightedText 
                  text={item.label} 
                  matches={item.matches}
                  className="text-sm truncate"
                />
                {item.description && (
                  <span className="text-xs text-muted-foreground/60 truncate ml-auto">
                    {item.description}
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              {fileIndexLoading 
                ? '正在索引文件...' 
                : query.trim() 
                  ? '未找到匹配的文件' 
                  : '暂无最近文件'}
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground/60 bg-muted/30 border-t border-border">
          <span>
            <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">↑↓</kbd> 导航
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Enter</kbd> 打开
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  )
}


// ============================================================================
// QuickOpen 主组件
// ============================================================================

/**
 * QuickOpen - 快速打开弹窗组件
 *
 * 提供文件快速搜索功能，支持：
 * - 模糊匹配文件名
 * - 最近文件优先显示
 * - 键盘导航（上下箭头、Enter、Esc、Home、End、PageUp、PageDown）
 * - 匹配字符高亮
 * - VS Code 风格文件图标
 */
export function QuickOpen({ workspacePath, className }: QuickOpenProps) {
  const quickOpenVisible = useWorkspaceStore((state) => state.quickOpenVisible)
  const closeQuickOpen = useWorkspaceStore((state) => state.closeQuickOpen)
  const openFile = useWorkspaceStore((state) => state.openFile)

  if (!quickOpenVisible) {
    return null
  }

  return (
    <QuickOpenContent
      key="quick-open-content"
      className={className}
      workspacePath={workspacePath}
      onClose={closeQuickOpen}
      onOpenFile={openFile}
    />
  )
}

// 导出模糊匹配函数供测试使用
export { fuzzyMatch, collectFilesRecursively }
