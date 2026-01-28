import { useState, useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Search, X, RefreshCw, ChevronRight, ChevronDown, FileText, CaseSensitive, Regex } from 'lucide-react'
import { useWorkspaceStore, type SearchResult } from '@/stores/workspaceStore'
import { api } from '@/api/client'
import type { ContentSearchMatch } from '@/api/types'
import { useDebounce } from '@/hooks/useDebounce'

/**
 * SearchPanel 组件属性
 */
export interface SearchPanelProps {
  /** 工作区路径 */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
}

/**
 * 搜索选项状态
 */
interface SearchOptions {
  caseSensitive: boolean
  isRegex: boolean
}

/**
 * 按文件分组的搜索结果
 */
interface GroupedResults {
  [filePath: string]: SearchResult[]
}

/**
 * 高亮匹配文本组件
 */
function HighlightedText({ 
  text, 
  matchStart, 
  matchEnd 
}: { 
  text: string
  matchStart: number
  matchEnd: number 
}) {
  if (matchStart < 0 || matchEnd <= matchStart || matchStart >= text.length) {
    return <span className="text-muted-foreground">{text}</span>
  }

  const before = text.slice(0, matchStart)
  const match = text.slice(matchStart, Math.min(matchEnd, text.length))
  const after = text.slice(Math.min(matchEnd, text.length))

  return (
    <span className="text-muted-foreground">
      {before}
      <span className="bg-yellow-500/30 text-foreground font-medium">{match}</span>
      {after}
    </span>
  )
}

/**
 * 单个搜索结果项组件
 */
function SearchResultItem({
  result,
  onClick,
}: {
  result: SearchResult
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'w-full text-left px-2 py-0.5 text-xs',
        'hover:bg-muted/50 cursor-pointer',
        'flex items-start gap-1'
      )}
      onClick={onClick}
    >
      <span className="text-muted-foreground/60 min-w-[3ch] text-right shrink-0">
        {result.lineNumber}
      </span>
      <span className="truncate flex-1 font-mono">
        <HighlightedText
          text={result.lineContent}
          matchStart={result.matchStart}
          matchEnd={result.matchEnd}
        />
      </span>
    </button>
  )
}

/**
 * 文件分组组件
 */
function FileGroup({
  filePath,
  results,
  workspacePath,
  onResultClick,
}: {
  filePath: string
  results: SearchResult[]
  workspacePath?: string
  onResultClick: (result: SearchResult) => void
}) {
  const [expanded, setExpanded] = useState(true)
  
  // 计算相对路径
  const displayPath = workspacePath && filePath.startsWith(workspacePath)
    ? filePath.slice(workspacePath.length).replace(/^[/\\]/, '')
    : filePath
  
  // 获取文件名
  const fileName = displayPath.split(/[/\\]/).pop() || displayPath

  return (
    <div className="mb-1">
      <button
        className={cn(
          'w-full flex items-center gap-1 px-2 py-1 text-xs',
          'hover:bg-muted/50 cursor-pointer'
        )}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
        <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate flex-1 text-left font-medium" title={displayPath}>
          {fileName}
        </span>
        <span className="text-muted-foreground/60 shrink-0">
          {results.length}
        </span>
      </button>
      
      {expanded && (
        <div className="ml-4">
          {results.map((result, index) => (
            <SearchResultItem
              key={`${result.lineNumber}-${index}`}
              result={result}
              onClick={() => onResultClick(result)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * SearchPanel - 搜索面板组件
 *
 * 提供项目内容搜索功能，支持：
 * - 文本搜索
 * - 正则表达式
 * - 大小写敏感切换
 * - 搜索结果分组显示
 * - 搜索结果高亮
 * - 优化的防抖处理
 * - 可取消的请求
 */
export function SearchPanel({ workspacePath, className }: SearchPanelProps) {
  const searchQuery = useWorkspaceStore((state) => state.searchQuery)
  const setSearchQuery = useWorkspaceStore((state) => state.setSearchQuery)
  const searchResults = useWorkspaceStore((state) => state.searchResults)
  const setSearchResults = useWorkspaceStore((state) => state.setSearchResults)
  const clearSearch = useWorkspaceStore((state) => state.clearSearch)
  const openFile = useWorkspaceStore((state) => state.openFile)

  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    isRegex: false,
  })
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalMatches, setTotalMatches] = useState(0)
  const [truncated, setTruncated] = useState(false)
  
  const inputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const searchVersionRef = useRef(0)

  // 使用优化的防抖 hook，延迟 300ms
  const debouncedQuery = useDebounce(searchQuery, 300)

  // 执行搜索（带取消功能）
  const performSearch = useCallback(async (query: string, searchVersion: number) => {
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    if (!query.trim() || !workspacePath) {
      setSearchResults([])
      setTotalMatches(0)
      setTruncated(false)
      setError(null)
      setIsSearching(false)
      return
    }

    // 验证正则表达式
    if (options.isRegex) {
      try {
        new RegExp(query)
      } catch {
        setError('无效的正则表达式')
        setIsSearching(false)
        return
      }
    }

    // 创建新的 AbortController
    const controller = new AbortController()
    abortControllerRef.current = controller

    setIsSearching(true)
    setError(null)

    try {
      const response = await api.fs.search({
        path: workspacePath,
        query: query.trim(),
        isRegex: options.isRegex,
        caseSensitive: options.caseSensitive,
        maxResults: 500,
      })

      // 检查是否被取消或版本过期
      if (controller.signal.aborted || searchVersion !== searchVersionRef.current) {
        return
      }

      const results: SearchResult[] = response.matches.map((match: ContentSearchMatch) => ({
        filePath: match.filePath,
        lineNumber: match.lineNumber,
        lineContent: match.lineContent,
        matchStart: match.matchStart,
        matchEnd: match.matchEnd,
      }))

      setSearchResults(results)
      setTotalMatches(response.totalMatches)
      setTruncated(response.truncated)
    } catch (err) {
      // 忽略取消错误
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      // 检查版本是否过期
      if (searchVersion !== searchVersionRef.current) {
        return
      }
      setError(err instanceof Error ? err.message : '搜索失败')
      setSearchResults([])
    } finally {
      // 只有当前版本的搜索才更新状态
      if (searchVersion === searchVersionRef.current) {
        setIsSearching(false)
      }
    }
  }, [workspacePath, options.isRegex, options.caseSensitive, setSearchResults])

  // 当防抖后的查询变化时执行搜索
  useEffect(() => {
    searchVersionRef.current += 1
    const currentVersion = searchVersionRef.current
    performSearch(debouncedQuery, currentVersion)
  }, [debouncedQuery, performSearch])

  // 选项变化时立即重新搜索（不需要防抖）
  useEffect(() => {
    if (searchQuery.trim()) {
      searchVersionRef.current += 1
      const currentVersion = searchVersionRef.current
      performSearch(searchQuery, currentVersion)
    }
  }, [options.caseSensitive, options.isRegex])

  // 组件卸载时取消请求
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  // 处理输入变化
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
  }

  // 清空搜索
  const handleClear = () => {
    clearSearch()
    setError(null)
    setTotalMatches(0)
    setTruncated(false)
    inputRef.current?.focus()
  }

  // 切换选项
  const toggleOption = (key: keyof SearchOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // 处理结果点击
  const handleResultClick = (result: SearchResult) => {
    openFile(result.filePath)
    // TODO: 跳转到指定行号
  }

  // 按文件分组结果
  const groupedResults: GroupedResults = searchResults.reduce((acc, result) => {
    if (!acc[result.filePath]) {
      acc[result.filePath] = []
    }
    acc[result.filePath].push(result)
    return acc
  }, {} as GroupedResults)

  const fileCount = Object.keys(groupedResults).length

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 搜索输入区域 */}
      <div className="p-2 space-y-2">
        {/* 搜索输入框 */}
        <div className="relative flex items-center">
          <Search className="absolute left-2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={handleInputChange}
            placeholder="搜索"
            className={cn(
              'w-full pl-8 pr-20 py-1.5 text-sm',
              'bg-muted/50 border border-border rounded',
              'focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary',
              'placeholder:text-muted-foreground/60'
            )}
          />
          
          {/* 搜索选项按钮 */}
          <div className="absolute right-1 flex items-center gap-0.5">
            {/* 大小写敏感 */}
            <button
              onClick={() => toggleOption('caseSensitive')}
              className={cn(
                'p-1 rounded hover:bg-muted',
                options.caseSensitive && 'bg-primary/20 text-primary'
              )}
              title="区分大小写 (Alt+C)"
            >
              <CaseSensitive className="w-4 h-4" />
            </button>
            
            {/* 正则表达式 */}
            <button
              onClick={() => toggleOption('isRegex')}
              className={cn(
                'p-1 rounded hover:bg-muted',
                options.isRegex && 'bg-primary/20 text-primary'
              )}
              title="使用正则表达式 (Alt+R)"
            >
              <Regex className="w-4 h-4" />
            </button>
            
            {/* 清空按钮 */}
            {searchQuery && (
              <button
                onClick={handleClear}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                title="清空搜索"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 搜索状态和结果 */}
      <div className="flex-1 overflow-auto">
        {/* 错误提示 */}
        {error && (
          <div className="px-2 py-2 text-xs text-destructive bg-destructive/10 mx-2 rounded">
            {error}
          </div>
        )}

        {/* 搜索中状态 */}
        {isSearching && (
          <div className="flex items-center justify-center py-4 text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" />
            <span className="text-sm">搜索中...</span>
          </div>
        )}

        {/* 搜索结果 */}
        {!isSearching && searchQuery && !error && (
          <>
            {/* 结果统计 */}
            {searchResults.length > 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground border-b border-border">
                {totalMatches} 个结果，{fileCount} 个文件
                {truncated && (
                  <span className="text-yellow-500 ml-1">（结果已截断）</span>
                )}
              </div>
            )}

            {/* 结果列表 */}
            {searchResults.length > 0 ? (
              <div className="py-1">
                {Object.entries(groupedResults).map(([filePath, results]) => (
                  <FileGroup
                    key={filePath}
                    filePath={filePath}
                    results={results}
                    workspacePath={workspacePath}
                    onResultClick={handleResultClick}
                  />
                ))}
              </div>
            ) : (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                未找到结果
              </div>
            )}
          </>
        )}

        {/* 空状态 */}
        {!searchQuery && !isSearching && (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            输入搜索内容
          </div>
        )}
      </div>
    </div>
  )
}
