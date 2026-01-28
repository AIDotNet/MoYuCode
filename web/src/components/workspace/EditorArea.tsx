import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, type CodeSelectionInfo } from '@/stores/workspaceStore'
import { EditorTabs } from './EditorTabs'
import { EditorContent } from './EditorContent'
import { CodeSelectionFloatingButton } from './CodeSelectionFloatingButton'
import type { MonacoCodeSelection } from '@/components/MonacoCode'

/**
 * EditorArea 组件属性
 */
export interface EditorAreaProps {
  /** 自定义类名 */
  className?: string
  /** 工作区路径（用于显示相对路径） */
  workspacePath?: string
}

/**
 * EditorArea - 编辑器区域组件
 *
 * 包含编辑器标签栏和编辑器内容区域。
 * 支持多标签页、代码编辑、Diff 查看等功能。
 */
export function EditorArea({ className, workspacePath }: EditorAreaProps) {
  const openTabs = useWorkspaceStore((state) => state.openTabs)
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const setCodeSelection = useWorkspaceStore((state) => state.setCodeSelection)
  const sendCodeSelectionToChat = useWorkspaceStore((state) => state.sendCodeSelectionToChat)

  // 本地代码选择状态（用于浮动按钮显示）
  const [localSelection, setLocalSelection] = useState<CodeSelectionInfo | null>(null)

  // 获取当前激活的标签页
  const activeTab = activeTabId
    ? openTabs.find((tab) => tab.id === activeTabId)
    : null

  /**
   * 处理代码选择变化
   */
  const handleSelectionChange = useCallback(
    (selection: MonacoCodeSelection | null, filePath?: string) => {
      if (!selection || !filePath) {
        setLocalSelection(null)
        setCodeSelection(null)
        return
      }

      const selectionInfo: CodeSelectionInfo = {
        filePath,
        startLine: selection.startLine,
        endLine: selection.endLine,
        text: selection.text,
      }

      setLocalSelection(selectionInfo)
      setCodeSelection(selectionInfo)
    },
    [setCodeSelection]
  )

  /**
   * 处理发送到聊天
   */
  const handleSendToChat = useCallback(
    (selection: CodeSelectionInfo) => {
      sendCodeSelectionToChat(selection)
    },
    [sendCodeSelectionToChat]
  )

  return (
    <div className={cn('flex flex-col h-full bg-background relative', className)}>
      {/* 编辑器标签栏 */}
      {openTabs.length > 0 && <EditorTabs />}

      {/* 编辑器内容 */}
      <div className="flex-1 overflow-hidden relative">
        <EditorContent
          activeTab={activeTab}
          onSelectionChange={handleSelectionChange}
        />

        {/* 代码选择浮动按钮 */}
        <CodeSelectionFloatingButton
          selection={localSelection}
          onSendToChat={handleSendToChat}
          workspacePath={workspacePath}
        />
      </div>
    </div>
  )
}
