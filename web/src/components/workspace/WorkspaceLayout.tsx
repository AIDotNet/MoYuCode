import { useCallback, useRef, useState, useEffect, Suspense } from 'react'
import { cn } from '@/lib/utils'
import {
  useWorkspaceStore,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH_RATIO,
  PANEL_MIN_HEIGHT,
  PANEL_MAX_HEIGHT_RATIO,
  type CodeSelectionInfo,
} from '@/stores/workspaceStore'
import { ActivityBar } from './ActivityBar'
import { Sidebar } from './Sidebar'
import { EditorArea } from './EditorArea'
import { BottomPanel } from './BottomPanel'
import { ResizeHandle } from './ResizeHandle'
import { LazyQuickOpen, LoadingFallback } from './LazyComponents'
import { useWorkspaceKeyboard } from '@/hooks/useWorkspaceKeyboard'

/**
 * WorkspaceLayout 组件属性
 */
export interface WorkspaceLayoutProps {
  /** 工作区路径 */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
  /** 子元素（可选，用于扩展） */
  children?: React.ReactNode
  /** 代码选择发送到聊天的回调 */
  onCodeSelectionToChat?: (selection: CodeSelectionInfo) => void
}

/**
 * WorkspaceLayout - 主工作区布局容器
 *
 * 整合所有工作区组件，提供类似 VS Code 的现代化布局：
 * - ActivityBar: 左侧活动栏，用于视图切换
 * - Sidebar: 侧边栏，显示文件资源管理器、搜索、Git 等
 * - EditorArea: 编辑器区域，包含标签栏和编辑器内容
 * - BottomPanel: 底部面板，包含终端、输出、问题等
 * - QuickOpen: 快速打开弹窗
 *
 * 布局结构：
 * ```
 * ┌────────────────────────────────────────────────────┐
 * │ ActivityBar │ Sidebar │ EditorArea                 │
 * │             │         │ ┌────────────────────────┐ │
 * │             │         │ │ EditorTabs             │ │
 * │             │         │ ├────────────────────────┤ │
 * │             │         │ │ EditorContent          │ │
 * │             │         │ │                        │ │
 * │             │         │ ├────────────────────────┤ │
 * │             │         │ │ BottomPanel            │ │
 * │             │         │ └────────────────────────┘ │
 * └────────────────────────────────────────────────────┘
 * ```
 */
export function WorkspaceLayout({
  workspacePath,
  className,
  children,
  onCodeSelectionToChat,
}: WorkspaceLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorAreaRef = useRef<HTMLDivElement>(null)

  // 注册工作区快捷键
  useWorkspaceKeyboard()

  // 监听待发送的代码选择
  const pendingChatSelection = useWorkspaceStore((state) => state.pendingChatSelection)
  const consumePendingChatSelection = useWorkspaceStore((state) => state.consumePendingChatSelection)

  // 当有待发送的代码选择时，调用回调
  useEffect(() => {
    if (pendingChatSelection && onCodeSelectionToChat) {
      const selection = consumePendingChatSelection()
      if (selection) {
        onCodeSelectionToChat(selection)
      }
    }
  }, [pendingChatSelection, onCodeSelectionToChat, consumePendingChatSelection])

  // 存储容器尺寸的状态
  const [containerWidth, setContainerWidth] = useState(window.innerWidth)
  const [editorAreaHeight, setEditorAreaHeight] = useState(window.innerHeight)

  // 从 store 获取状态
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const sidebarWidth = useWorkspaceStore((state) => state.sidebarWidth)
  const setSidebarWidth = useWorkspaceStore((state) => state.setSidebarWidth)
  const panelVisible = useWorkspaceStore((state) => state.panelVisible)
  const panelHeight = useWorkspaceStore((state) => state.panelHeight)
  const setPanelHeight = useWorkspaceStore((state) => state.setPanelHeight)

  // 监听容器尺寸变化
  useEffect(() => {
    const updateSizes = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth)
      }
      if (editorAreaRef.current) {
        setEditorAreaHeight(editorAreaRef.current.clientHeight)
      }
    }

    // 初始化尺寸
    updateSizes()

    // 监听窗口大小变化
    window.addEventListener('resize', updateSizes)

    // 使用 ResizeObserver 监听容器尺寸变化
    const resizeObserver = new ResizeObserver(updateSizes)
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }
    if (editorAreaRef.current) {
      resizeObserver.observe(editorAreaRef.current)
    }

    return () => {
      window.removeEventListener('resize', updateSizes)
      resizeObserver.disconnect()
    }
  }, [])

  /**
   * 计算侧边栏最大宽度
   */
  const sidebarMaxWidth = Math.floor(containerWidth * SIDEBAR_MAX_WIDTH_RATIO)

  /**
   * 计算底部面板最大高度
   */
  const panelMaxHeight = Math.floor(editorAreaHeight * PANEL_MAX_HEIGHT_RATIO)

  /**
   * 处理侧边栏宽度变化
   */
  const handleSidebarWidthChange = useCallback(
    (newWidth: number) => {
      setSidebarWidth(newWidth, containerWidth)
    },
    [containerWidth, setSidebarWidth]
  )

  /**
   * 处理底部面板高度变化
   */
  const handlePanelHeightChange = useCallback(
    (newHeight: number) => {
      setPanelHeight(newHeight, editorAreaHeight)
    },
    [editorAreaHeight, setPanelHeight]
  )

  return (
    <div
      ref={containerRef}
      className={cn('flex h-full w-full overflow-hidden bg-background', className)}
    >
      {/* 活动栏 */}
      <ActivityBar />

      {/* 侧边栏 - 始终渲染以支持展开/折叠动画 */}
      <Sidebar workspacePath={workspacePath} />

      {/* 侧边栏拖拽手柄 - 仅在侧边栏可见时显示 */}
      {sidebarVisible && (
        <ResizeHandle
          direction="horizontal"
          size={sidebarWidth}
          minSize={SIDEBAR_MIN_WIDTH}
          maxSize={sidebarMaxWidth}
          onSizeChange={handleSidebarWidthChange}
        />
      )}

      {/* 编辑器区域（包含底部面板） */}
      <div ref={editorAreaRef} className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 编辑器主区域 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <EditorArea workspacePath={workspacePath} />
        </div>

        {/* 底部面板拖拽手柄 */}
        {panelVisible && (
          <ResizeHandle
            direction="vertical"
            size={panelHeight}
            minSize={PANEL_MIN_HEIGHT}
            maxSize={panelMaxHeight}
            onSizeChange={handlePanelHeightChange}
            inverted
          />
        )}

        {/* 底部面板 */}
        <BottomPanel workspacePath={workspacePath} />
      </div>

      {/* 快速打开弹窗（懒加载） */}
      <Suspense fallback={<LoadingFallback />}>
        <LazyQuickOpen workspacePath={workspacePath} />
      </Suspense>

      {/* 扩展内容 */}
      {children}
    </div>
  )
}
