import { memo } from 'react'
import { ClaudeAskUserQuestionTool } from '@/components/project-workspace/ClaudeAskUserQuestionTool'
import { ClaudeTodoWriteTool } from '@/components/project-workspace/ClaudeTodoWriteTool'
import { TaskToolContent } from '@/components/project-workspace/tool-contents/TaskToolContent'
import { WriteToolContent } from '@/components/project-workspace/tool-contents/WriteToolContent'
import { ReadToolContent } from '@/components/project-workspace/tool-contents/ReadToolContent'
import { EditToolContent } from '@/components/project-workspace/tool-contents/EditToolContent'
import { BashToolContent } from '@/components/project-workspace/tool-contents/BashToolContent'
import { GlobToolContent } from '@/components/project-workspace/tool-contents/GlobToolContent'
import { DefaultToolContent } from '@/components/project-workspace/tool-contents/DefaultToolContent'
import { ToolOutputContent } from '@/components/project-workspace/tool-contents/ToolOutputContent'
import type { ToolInputData } from '@/components/project-workspace/tool-inputs/useToolInputParsers'

interface ToolItemContentProps {
  inputData: ToolInputData
  output: string
  isError: boolean
  readCode: string | null
  editDiff: string
  message: {
    id: string
    toolUseId?: string
  }
  askUserQuestionDisabled: boolean
  onSubmitAskUserQuestion?: (toolUseId: string, answers: Record<string, string>, messageId: string) => void
}

export const ToolItemContent = memo(function ToolItemContent({
  inputData,
  output,
  isError,
  readCode,
  editDiff,
  message,
  askUserQuestionDisabled,
  onSubmitAskUserQuestion,
}: ToolItemContentProps) {
  const { taskInput, askInput, writeInput, readInput, editInput, todoWriteInput, bashInput, globInput } = inputData

  const shouldShowOutput = Boolean(
    output &&
    !editInput &&
    !bashInput &&
    !globInput &&
    (!todoWriteInput || isError) &&
    (!readInput || isError) &&
    (!taskInput || isError)
  )

  return (
    <>
      {taskInput ? (
        <TaskToolContent input={taskInput} />
      ) : askInput ? (
        <ClaudeAskUserQuestionTool
          input={askInput}
          disabled={
            askUserQuestionDisabled || Boolean(output) || !message.toolUseId || !onSubmitAskUserQuestion
          }
          onSubmit={(answers) => {
            if (!message.toolUseId || !onSubmitAskUserQuestion) return
            onSubmitAskUserQuestion(message.toolUseId, answers, message.id)
          }}
        />
      ) : writeInput ? (
        <WriteToolContent input={writeInput} />
      ) : readInput ? (
        <ReadToolContent input={readInput} code={readCode ?? ''} />
      ) : editInput ? (
        <EditToolContent input={editInput} diff={editDiff} />
      ) : bashInput ? (
        <BashToolContent input={bashInput} output={output} />
      ) : globInput ? (
        <GlobToolContent input={globInput} output={output} />
      ) : todoWriteInput ? (
        <ClaudeTodoWriteTool input={todoWriteInput} />
      ) : (
        <DefaultToolContent input={output || ''} />
      )}

      {shouldShowOutput ? (
        <ToolOutputContent output={output} />
      ) : null}
    </>
  )
})
