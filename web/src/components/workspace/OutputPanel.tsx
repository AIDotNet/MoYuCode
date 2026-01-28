import { cn } from '@/lib/utils'
import { Trash2, Search, Filter, X, ChevronDown } from 'lucide-react'
import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { useWorkspaceStore, type OutputItem, type OutputType } from '@/stores/workspaceStore'

// 从 store 重新导出类型，方便外部使用
export type { OutputItem, OutputType }

/**
 * OutputPanel 组件属性
 */
export interface OutputPanelProps {
  /** 自定义类名 */
  className?: string
}

/**
 * 输出类型过滤选项
 */
const OUTPUT_TYPE_FILTERS: { id: OutputType | 'all'; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'info', label: '信息' },
  { id: 'warning', label: '警告' },
  { id: 'error', label: '错误' },
  { id: 'success', label: '成功' },
  { id: 'tool', label: '工具' },
]

/**
 * OutputPanel - 输出面板组件
 *
 * 显示工具调用输出、日志等信息，支持：
 * - 不同类型的输出（info, warning, error, success, tool）
 * - 清空输出
 * - 按类型过滤
 * - 搜索输出内容
 * - 自动滚动到底部
 */
export function OutputPanel({ className }: OutputPanelProps) {
  // 从 store 获取状态和 actions
  const outputs = useWorkspaceStore((state) => state.outputs)
  const outputSearchQuery = useWorkspaceStore((state) => state.outputSearchQuery)
  const outputTypeFilter = useWorkspaceStore((state) => state.outputTypeFilter)
  const clearOutputs = useWorkspaceStore((state) => state.clearOutputs)
  const setOutputSearchQuery = useWorkspaceStore((state) => state.setOutputSearchQuery)
  const setOutputTypeFilter = useWorkspaceStore((state) => state.setOutputTypeFilter)

  // 本地 UI 状态
  const [showSearch, setShowSearch] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  
  const outputContainerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && outputContainerRef.current) {
      outputContainerRef.current.scrollTop = outputContainerRef.current.scrollHeight
    }
  }, [outputs, autoScroll])

  // 聚焦搜索框
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [showSearch])

  /**
   * 过滤后的输出
   */
  const filteredOutputs = useMemo(() => {
    let result = outputs

    // 按类型过滤
    if (outputTypeFilter !== 'all') {
      result = result.filter((o) => o.type === outputTypeFilter)
    }

    // 按搜索词过滤
    if (outputSearchQuery.trim()) {
      const query = outputSearchQuery.toLowerCase()
      result = result.filter(
        (o) =>
          o.content.toLowerCase().includes(query) ||
          o.source?.toLowerCase().includes(query) ||
          o.toolName?.toLowerCase().includes(query)
      )
    }

    return result
  }, [outputs, outputTypeFilter, outputSearchQuery])

  /**
   * 清空输出
   */
  const handleClear = useCallback(() => {
    clearOutputs()
  }, [clearOutputs])

  /**
   * 切换搜索框
   */
  const toggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      if (prev) {
        setOutputSearchQuery('')
      }
      return !prev
    })
  }, [setOutputSearchQuery])

  /**
   * 切换过滤器
   */
  const toggleFilters = useCallback(() => {
    setShowFilters((prev) => !prev)
  }, [])

  /**
   * 获取输出类型对应的样式
   */
  const getOutputTypeStyle = (type: OutputType) => {
    switch (type) {
      case 'info':
        return 'text-blue-400'
      case 'warning':
        return 'text-yellow-400'
      case 'error':
        return 'text-red-400'
      case 'success':
        return 'text-green-400'
      case 'tool':
        return 'text-purple-400'
      default:
        return 'text-muted-foreground'
    }
  }

  /**
   * 获取输出类型图标/标签
   */
  const getOutputTypeLabel = (type: OutputType) => {
    switch (type) {
      case 'info':
        return '[INFO]'
      case 'warning':
        return '[WARN]'
      case 'error':
        return '[ERROR]'
      case 'success':
        return '[OK]'
      case 'tool':
        return '[TOOL]'
      default:
        return ''
    }
  }

  /**
   * 格式化时间戳
   */
  const formatTimestamp = (date: Date) => {
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  /**
   * 格式化工具参数显示
   */
  const formatToolArgs = (args: Record<string, unknown> | undefined) => {
    if (!args || Object.keys(args).length === 0) return null
    
    try {
      // 简化显示：只显示关键参数
      const entries = Object.entries(args)
      if (entries.length === 0) return null
      
      return entries.map(([key, value]) => {
        let displayValue: string
        if (typeof value === 'string') {
          // 截断过长的字符串
          displayValue = value.length > 100 ? value.substring(0, 100) + '...' : value
        } else if (typeof value === 'object') {
          displayValue = JSON.stringify(value).substring(0, 50) + '...'
        } else {
          displayValue = String(value)
        }
        return `${key}: ${displayValue}`
      }).join(', ')
    } catch {
      return null
    }
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 bg-muted/20 border-b border-border">
        {/* 左侧：搜索框 */}
        <div className="flex items-center gap-1 flex-1">
          {showSearch && (
            <div className="flex items-center gap-1 flex-1 max-w-xs">
              <Input
                ref={searchInputRef}
                value={outputSearchQuery}
                onChange={(e) => setOutputSearchQuery(e.target.value)}
                placeholder="搜索输出..."
                className="h-6 text-xs"
              />
              <button
                className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                onClick={() => {
                  setOutputSearchQuery('')
                  setShowSearch(false)
                }}
                aria-label="关闭搜索"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* 右侧：操作按钮 */}
        <div className="flex items-center gap-1">
          {/* 过滤器下拉 */}
          <div className="relative">
            <button
              className={cn(
                'flex items-center gap-1 px-1.5 py-1 text-xs rounded transition-colors',
                outputTypeFilter !== 'all'
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
              onClick={toggleFilters}
              aria-label="过滤类型"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{OUTPUT_TYPE_FILTERS.find((f) => f.id === outputTypeFilter)?.label}</span>
              <ChevronDown className="w-3 h-3" />
            </button>

            {/* 过滤器下拉菜单 */}
            {showFilters && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[80px]">
                {OUTPUT_TYPE_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    className={cn(
                      'w-full px-3 py-1 text-xs text-left hover:bg-muted transition-colors',
                      outputTypeFilter === filter.id && 'text-primary bg-primary/10'
                    )}
                    onClick={() => {
                      setOutputTypeFilter(filter.id)
                      setShowFilters(false)
                    }}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 搜索按钮 */}
          <button
            className={cn(
              'p-1 rounded transition-colors',
              showSearch
                ? 'text-primary bg-primary/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
            onClick={toggleSearch}
            aria-label="搜索"
          >
            <Search className="w-4 h-4" />
          </button>

          {/* 清空按钮 */}
          <button
            className={cn(
              'p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors',
              outputs.length === 0 && 'opacity-50 cursor-not-allowed'
            )}
            onClick={handleClear}
            aria-label="清空输出"
            disabled={outputs.length === 0}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 输出内容 */}
      <div 
        ref={outputContainerRef}
        className="flex-1 overflow-auto bg-[#1e1e1e] p-2 font-mono text-sm"
        onScroll={(e) => {
          const target = e.target as HTMLDivElement
          const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 10
          setAutoScroll(isAtBottom)
        }}
      >
        {filteredOutputs.length > 0 ? (
          filteredOutputs.map((output) => (
            <div key={output.id} className="py-0.5">
              {output.type === 'tool' ? (
                // 工具调用的特殊显示
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-muted-foreground/60 shrink-0">
                      [{formatTimestamp(output.timestamp)}]
                    </span>
                    <span className={cn(
                      'font-semibold',
                      getOutputTypeStyle(output.type)
                    )}>
                      {getOutputTypeLabel(output.type)}
                    </span>
                    {output.toolName && (
                      <span className="text-purple-300 font-medium">
                        {output.toolName}
                      </span>
                    )}
                    {output.toolStatus && (
                      <span className={cn(
                        'text-xs px-1.5 py-0.5 rounded',
                        output.toolStatus === 'running' && 'bg-yellow-500/20 text-yellow-400 animate-pulse',
                        output.toolStatus === 'success' && 'bg-green-500/20 text-green-400',
                        output.toolStatus === 'error' && 'bg-red-500/20 text-red-400'
                      )}>
                        {output.toolStatus === 'running' ? '执行中...' : 
                         output.toolStatus === 'success' ? '成功' : '失败'}
                      </span>
                    )}
                  </div>
                  {/* 工具参数显示 */}
                  {output.toolArgs && Object.keys(output.toolArgs).length > 0 && (
                    <div className="ml-4 text-xs text-muted-foreground/60">
                      <span className="text-muted-foreground/40">参数: </span>
                      {formatToolArgs(output.toolArgs)}
                    </div>
                  )}
                  {output.content && (
                    <div className="ml-4 text-muted-foreground/80 whitespace-pre-wrap">
                      {output.content}
                    </div>
                  )}
                  {output.toolResult && (
                    <div className="ml-4 mt-1 p-2 bg-muted/20 rounded text-xs text-muted-foreground/70 whitespace-pre-wrap max-h-32 overflow-auto">
                      {output.toolResult}
                    </div>
                  )}
                </div>
              ) : (
                // 普通输出显示
                <div className="flex gap-2">
                  <span className="text-muted-foreground/60 shrink-0">
                    [{formatTimestamp(output.timestamp)}]
                  </span>
                  <span className={cn('font-semibold shrink-0', getOutputTypeStyle(output.type))}>
                    {getOutputTypeLabel(output.type)}
                  </span>
                  {output.source && (
                    <span className="text-muted-foreground/60 shrink-0">
                      [{output.source}]
                    </span>
                  )}
                  <span className="text-foreground/90 whitespace-pre-wrap break-all">
                    {output.content}
                  </span>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground/60">
            {outputs.length === 0 ? '暂无输出' : '没有匹配的输出'}
          </div>
        )}
      </div>
    </div>
  )
}
