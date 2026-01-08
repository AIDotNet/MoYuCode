import { memo, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToolInputParsers } from '@/components/project-workspace/tool-inputs/useToolInputParsers'
import { ToolItemContent } from '@/components/project-workspace/tool-contents/ToolItemContent'
import {
  buildReplacementDiff,
  computeReplacementDiffStats,
  tryExtractReadToolOutput,
  normalizeReadToolOutputForMonaco,
  normalizeNewlines,
  getBaseName,
  truncateInlineText,
} from '@/lib/toolUtils'
import type { OpenById } from '@/components/project-workspace/ProjectChat'

interface ChatMessage {
  id: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolIsError?: boolean
  toolUseId?: string
}

interface ChatToolCallItemProps {
  message: ChatMessage
  openById: OpenById
  onToggle: (id: string) => void
  onSubmitAskUserQuestion?: (toolUseId: string, answers: Record<string, string>, messageId: string) => void
  askUserQuestionDisabled: boolean
}

export const ChatToolCallItem = memo(function ChatToolCallItem({
  message,
  openById,
  onToggle,
  onSubmitAskUserQuestion,
  askUserQuestionDisabled,
}: ChatToolCallItemProps) {
  const open = openById[message.id] ?? false
  const toolName = message.toolName ?? 'tool'
  const input = message.toolInput ?? ''
  const output = message.toolOutput ?? ''
  const isError = Boolean(message.toolIsError)

  const inputData = useToolInputParsers(toolName, input)

  const diffStats = useMemo(() => {
    if (!inputData.editInput) return null
    if (normalizeNewlines(inputData.editInput.oldString) === normalizeNewlines(inputData.editInput.newString)) {
      return null
    }
    return computeReplacementDiffStats(inputData.editInput.oldString, inputData.editInput.newString)
  }, [inputData.editInput])

  const editDiff = useMemo(() => {
    if (!inputData.editInput) return ''
    if (normalizeNewlines(inputData.editInput.oldString) === normalizeNewlines(inputData.editInput.newString)) {
      return ''
    }
    return buildReplacementDiff(inputData.editInput.filePath, inputData.editInput.oldString, inputData.editInput.newString)
  }, [inputData.editInput])

  const readCode = useMemo(() => {
    if (!inputData.readInput) return null
    if (inputData.readInput.content != null) {
      return normalizeReadToolOutputForMonaco(inputData.readInput.content)
    }
    const extracted = tryExtractReadToolOutput(output)
    return normalizeReadToolOutputForMonaco(extracted ?? output)
  }, [output, inputData.readInput])

  const title = useMemo(() => {
    if (inputData.editInput) {
      return `Edit ${getBaseName(inputData.editInput.filePath)}`
    }
    if (inputData.writeInput) {
      return `Write ${getBaseName(inputData.writeInput.filePath)}`
    }
    if (inputData.readInput) {
      return `Read ${getBaseName(inputData.readInput.filePath)}`
    }
    if (inputData.bashInput) {
      return 'Bash'
    }
    if (inputData.globInput) {
      return 'Glob'
    }
    if (inputData.taskInput) {
      return `Task${inputData.taskInput.subagentType ? ` ${inputData.taskInput.subagentType}` : ''}`
    }
    if (inputData.askInput?.questions?.length) {
      return 'AskUserQuestion'
    }
    if (inputData.todoWriteInput) {
      return 'TodoWrite'
    }
    return toolName
  }, [inputData, toolName])

  const inputPreview = useMemo(() => {
    if (inputData.askInput?.questions?.length) {
      return truncateInlineText(inputData.askInput.questions[0].question, 140)
    }
    if (inputData.writeInput) {
      return truncateInlineText(inputData.writeInput.filePath, 140)
    }
    if (inputData.readInput) {
      return truncateInlineText(inputData.readInput.filePath, 140)
    }
    if (inputData.bashInput) {
      return truncateInlineText(inputData.bashInput.description || inputData.bashInput.command, 140)
    }
    if (inputData.globInput) {
      return truncateInlineText(inputData.globInput.pattern, 140)
    }
    if (inputData.taskInput) {
      return truncateInlineText(inputData.taskInput.description || inputData.taskInput.prompt || inputData.taskInput.subagentType, 140)
    }
    if (inputData.editInput) {
      return truncateInlineText(inputData.editInput.filePath, 140)
    }
    if (inputData.todoWriteInput) {
      return inputData.todoWriteInput.todos.length
        ? `${inputData.todoWriteInput.todos.length} todos`
        : '0 todos'
    }
    if (input) {
      return truncateInlineText(input, 140)
    }
    return ''
  }, [inputData, input])

  return (
    <div className="rounded-md border bg-background/40">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          '!h-auto w-full items-start justify-between gap-3 px-2 py-2 text-xs font-medium text-muted-foreground',
          'hover:bg-accent/40',
        )}
        aria-expanded={open}
        aria-controls={`tool-item-${message.id}`}
        onClick={() => onToggle(message.id)}
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground/90">{title}</span>
            {diffStats ? (
              <>
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-emerald-400">
                  +{diffStats.added}
                </Badge>
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-rose-400">
                  -{diffStats.removed}
                </Badge>
              </>
            ) : null}
            {isError ? (
              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                error
              </Badge>
            ) : null}
          </span>
          {inputPreview ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{inputPreview}</span>
          ) : null}
        </span>
        <ChevronDown
          className={cn('mt-0.5 size-4 shrink-0 transition-transform', open ? 'rotate-0' : '-rotate-90')}
        />
      </Button>

      {open ? (
        <div id={`tool-item-${message.id}`} className="space-y-2 px-2 pb-2 text-xs">
          <ToolItemContent
            inputData={inputData}
            output={output}
            isError={isError}
            readCode={readCode}
            editDiff={editDiff}
            message={message}
            askUserQuestionDisabled={askUserQuestionDisabled}
            onSubmitAskUserQuestion={onSubmitAskUserQuestion}
          />
        </div>
      ) : null}
    </div>
  )
})
