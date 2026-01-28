import { useEffect } from 'react'
import { useWorkspaceStore, type CodeSelectionInfo } from '@/stores/workspaceStore'

/**
 * useCodeSelectionToChat Hook
 *
 * 监听 workspaceStore 中的 pendingChatSelection，
 * 当有待发送的代码选择时，调用回调函数。
 *
 * @param onCodeSelection - 当有代码选择需要发送到聊天时的回调
 */
export function useCodeSelectionToChat(
  onCodeSelection?: (selection: CodeSelectionInfo) => void
) {
  const pendingChatSelection = useWorkspaceStore((state) => state.pendingChatSelection)
  const consumePendingChatSelection = useWorkspaceStore((state) => state.consumePendingChatSelection)

  useEffect(() => {
    if (pendingChatSelection && onCodeSelection) {
      // 消费待发送的选择
      const selection = consumePendingChatSelection()
      if (selection) {
        onCodeSelection(selection)
      }
    }
  }, [pendingChatSelection, onCodeSelection, consumePendingChatSelection])
}

/**
 * 将 CodeSelectionInfo 转换为 CodeSelection 类型（用于 ProjectChat）
 */
export function toCodeSelection(info: CodeSelectionInfo): {
  filePath: string
  startLine: number
  endLine: number
  text: string
} {
  return {
    filePath: info.filePath,
    startLine: info.startLine,
    endLine: info.endLine,
    text: info.text,
  }
}

/**
 * 格式化代码选择为聊天消息格式
 *
 * @param selection - 代码选择信息
 * @param workspacePath - 工作区路径（可选，用于生成相对路径）
 * @returns 格式化后的消息文本
 */
export function formatCodeSelectionForChat(
  selection: CodeSelectionInfo,
  workspacePath?: string
): string {
  const { filePath, startLine, endLine, text } = selection

  // 尝试获取相对路径
  let displayPath = filePath
  if (workspacePath) {
    const normalizedWorkspace = workspacePath.replace(/[\\/]+$/, '').toLowerCase()
    const normalizedFile = filePath.toLowerCase()
    if (normalizedFile.startsWith(normalizedWorkspace)) {
      displayPath = filePath.slice(workspacePath.length).replace(/^[\\/]+/, '')
    }
  }

  // 格式化行号
  const lineInfo = startLine === endLine
    ? `L${startLine}`
    : `L${startLine}-L${endLine}`

  // 返回格式化的消息
  return `\`${displayPath}:${lineInfo}\`\n\`\`\`\n${text}\n\`\`\``
}
