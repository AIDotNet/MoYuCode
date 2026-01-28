import { useCallback, useMemo, useState, useRef } from 'react'
import { cn } from '@/lib/utils'
import { MessageSquarePlus, Copy, Check, FileCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * 代码选择信息
 */
export interface CodeSelectionInfo {
  /** 文件路径 */
  filePath: string
  /** 起始行号 */
  startLine: number
  /** 结束行号 */
  endLine: number
  /** 选中的代码文本 */
  text: string
}

/**
 * CodeSelectionFloatingButton 组件属性
 */
export interface CodeSelectionFloatingButtonProps {
  /** 代码选择信息 */
  selection: CodeSelectionInfo | null
  /** 发送到聊天回调 */
  onSendToChat?: (selection: CodeSelectionInfo) => void
  /** 工作区路径（用于显示相对路径） */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
}

/**
 * 从完整路径获取文件名
 */
function getFileName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return normalized
  return normalized.slice(lastSeparator + 1) || normalized
}

/**
 * 获取相对路径
 */
function getRelativePath(filePath: string, workspacePath?: string): string {
  if (!workspacePath) return filePath

  const normalizedWorkspace = workspacePath.replace(/[\\/]+$/, '').toLowerCase()
  const normalizedFile = filePath.toLowerCase()

  if (normalizedFile.startsWith(normalizedWorkspace)) {
    const relative = filePath.slice(workspacePath.length).replace(/^[\\/]+/, '')
    return relative || filePath
  }

  return filePath
}

/**
 * CodeSelectionFloatingButton - 代码选择浮动操作按钮
 *
 * 当用户在编辑器中选择代码时，显示一个浮动按钮，
 * 允许用户将选中的代码发送到聊天中。
 */
export function CodeSelectionFloatingButton({
  selection,
  onSendToChat,
  workspacePath,
  className,
}: CodeSelectionFloatingButtonProps) {
  // 使用选择的 key 和复制状态组合
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 计算是否显示
  const visible = useMemo(() => {
    return selection !== null && selection.text.trim().length > 0
  }, [selection])

  // 生成选择的唯一 key
  const selectionKey = useMemo(() => {
    if (!selection) return null
    return `${selection.filePath}:${selection.startLine}:${selection.endLine}`
  }, [selection])

  // 判断是否显示复制成功状态
  const showCopied = copiedKey !== null && copiedKey === selectionKey

  // 清理定时器
  const cleanupTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  /**
   * 处理发送到聊天
   */
  const handleSendToChat = useCallback(() => {
    if (selection && onSendToChat) {
      onSendToChat(selection)
    }
  }, [selection, onSendToChat])

  /**
   * 处理复制代码
   */
  const handleCopy = useCallback(async () => {
    if (!selection || !selectionKey) return

    try {
      await navigator.clipboard.writeText(selection.text)
      setCopiedKey(selectionKey)
      
      // 2秒后重置复制状态
      cleanupTimeout()
      timeoutRef.current = setTimeout(() => {
        setCopiedKey(null)
      }, 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }, [selection, selectionKey, cleanupTimeout])

  // 不显示时返回 null
  if (!visible || !selection) {
    return null
  }

  const lineCount = selection.endLine - selection.startLine + 1
  const lineLabel = lineCount === 1 
    ? `L${selection.startLine}` 
    : `L${selection.startLine}-${selection.endLine}`

  // 获取文件名和相对路径
  const fileName = getFileName(selection.filePath)
  const relativePath = getRelativePath(selection.filePath, workspacePath)

  return (
    <div
      className={cn(
        'absolute bottom-4 right-4 z-50',
        'flex items-center gap-1.5 p-1.5',
        'bg-background/95 backdrop-blur-sm',
        'border border-border/50 rounded-lg shadow-lg',
        'animate-in fade-in slide-in-from-bottom-2 duration-200',
        className
      )}
    >
      {/* 文件信息 */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 px-2 cursor-default max-w-[200px]">
              <FileCode className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-xs text-muted-foreground truncate">
                {fileName}
              </span>
              <span className="text-xs text-primary font-medium flex-shrink-0">
                {lineLabel}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[300px]">
            <p className="text-xs break-all">{relativePath}:{lineLabel}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="w-px h-4 bg-border/50" />

      {/* 复制按钮 */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleCopy}
            >
              {showCopied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{showCopied ? '已复制' : '复制代码'}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* 发送到聊天按钮 */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleSendToChat}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>发送到聊天</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
