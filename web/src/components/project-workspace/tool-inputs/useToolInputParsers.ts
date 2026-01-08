import { useMemo } from 'react'
import type { TaskToolInput } from '@/components/project-workspace/tool-inputs/types'
import type { TodoWriteToolInput } from '@/components/project-workspace/tool-inputs/types'
import type { AskUserQuestionToolInput } from '@/components/project-workspace/tool-inputs/types'
import {
  tryParseTaskToolInput,
  tryParseTodoWriteToolInput,
  tryParseAskUserQuestionToolInput,
  tryParseWriteToolInput,
  tryParseReadToolInput,
  tryParseEditToolInput,
  tryParseBashToolInput,
  tryParseGlobToolInput,
  isTaskToolName,
  isTodoWriteToolName,
  isAskUserQuestionToolName,
  isWriteToolName,
  isReadToolName,
  isEditToolName,
  isBashToolName,
  isGlobToolName,
} from '@/lib/toolInputParsers'
import type { WriteToolInput, ReadToolInput, EditToolInput, BashToolInput, GlobToolInput } from '@/lib/toolInputParsers'

export type ToolInputData = {
  taskInput: TaskToolInput | null
  askInput: AskUserQuestionToolInput | null
  writeInput: WriteToolInput | null
  readInput: ReadToolInput | null
  editInput: EditToolInput | null
  todoWriteInput: TodoWriteToolInput | null
  bashInput: BashToolInput | null
  globInput: GlobToolInput | null
}

export function useToolInputParsers(toolName: string, input: string): ToolInputData {
  return useMemo(() => {
    const base = {
      taskInput: null,
      askInput: null,
      writeInput: null,
      readInput: null,
      editInput: null,
      todoWriteInput: null,
      bashInput: null,
      globInput: null,
    }

    if (isTaskToolName(toolName)) {
      return { ...base, taskInput: tryParseTaskToolInput(input) }
    }
    if (isAskUserQuestionToolName(toolName)) {
      return { ...base, askInput: tryParseAskUserQuestionToolInput(input) }
    }
    if (isWriteToolName(toolName)) {
      return { ...base, writeInput: tryParseWriteToolInput(input) }
    }
    if (isReadToolName(toolName)) {
      return { ...base, readInput: tryParseReadToolInput(input) }
    }
    if (isEditToolName(toolName)) {
      return { ...base, editInput: tryParseEditToolInput(input) }
    }
    if (isTodoWriteToolName(toolName)) {
      return { ...base, todoWriteInput: tryParseTodoWriteToolInput(input) }
    }
    if (isBashToolName(toolName)) {
      return { ...base, bashInput: tryParseBashToolInput(input) }
    }
    if (isGlobToolName(toolName)) {
      return { ...base, globInput: tryParseGlobToolInput(input) }
    }

    return base
  }, [input, toolName])
}
