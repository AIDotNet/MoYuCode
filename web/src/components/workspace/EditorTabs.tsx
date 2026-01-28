import { useState, useRef, useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { X, FileCode, ChevronLeft, ChevronRight } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspaceStore'

/**
 * EditorTabs 组件属性
 */
export interface EditorTabsProps {
  /** 自定义类名 */
  className?: string
}

/**
 * 右键菜单状态
 */
interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  tabId: string | null
}

/**
 * EditorTabs - 编辑器标签栏组件
 *
 * 显示打开的文件标签页，支持：
 * - 标签页切换
 * - 关闭标签页
 * - 修改指示器
 * - 拖拽排序
 * - 右键菜单（关闭、关闭其他、关闭所有）
 * - 滚动溢出处理
 */
export function EditorTabs({ className }: EditorTabsProps) {
  const openTabs = useWorkspaceStore((state) => state.openTabs)
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const closeOtherTabs = useWorkspaceStore((state) => state.closeOtherTabs)
  const closeAllTabs = useWorkspaceStore((state) => state.closeAllTabs)
  const reorderTabs = useWorkspaceStore((state) => state.reorderTabs)

  // 拖拽状态
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null)

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    tabId: null,
  })

  // 滚动状态
  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  /**
   * 检查滚动状态
   */
  const checkScrollState = useCallback(() => {
    const container = tabsContainerRef.current
    if (!container) return

    setCanScrollLeft(container.scrollLeft > 0)
    setCanScrollRight(
      container.scrollLeft < container.scrollWidth - container.clientWidth - 1
    )
  }, [])

  /**
   * 监听滚动和窗口大小变化
   */
  useEffect(() => {
    const container = tabsContainerRef.current
    if (!container) return

    checkScrollState()

    container.addEventListener('scroll', checkScrollState)
    window.addEventListener('resize', checkScrollState)

    // 使用 ResizeObserver 监听容器大小变化
    const resizeObserver = new ResizeObserver(checkScrollState)
    resizeObserver.observe(container)

    return () => {
      container.removeEventListener('scroll', checkScrollState)
      window.removeEventListener('resize', checkScrollState)
      resizeObserver.disconnect()
    }
  }, [checkScrollState, openTabs.length])

  /**
   * 滚动标签栏
   */
  const scrollTabs = (direction: 'left' | 'right') => {
    const container = tabsContainerRef.current
    if (!container) return

    const scrollAmount = 150
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    })
  }

  /**
   * 处理标签页点击
   */
  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId)
  }

  /**
   * 处理关闭标签页
   */
  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation()
    closeTab(tabId)
  }

  /**
   * 处理中键点击关闭
   */
  const handleMouseDown = (e: React.MouseEvent, tabId: string) => {
    if (e.button === 1) {
      // 中键点击
      e.preventDefault()
      closeTab(tabId)
    }
  }

  // =========================================================================
  // 拖拽排序处理
  // =========================================================================

  /**
   * 拖拽开始
   */
  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    setDraggedTabId(tabId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tabId)

    // 设置拖拽图像透明度
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5'
    }
  }

  /**
   * 拖拽结束
   */
  const handleDragEnd = (e: React.DragEvent) => {
    setDraggedTabId(null)
    setDragOverTabId(null)

    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
  }

  /**
   * 拖拽经过
   */
  const handleDragOver = (e: React.DragEvent, tabId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    if (draggedTabId && draggedTabId !== tabId) {
      setDragOverTabId(tabId)
    }
  }

  /**
   * 拖拽离开
   */
  const handleDragLeave = () => {
    setDragOverTabId(null)
  }

  /**
   * 放置
   */
  const handleDrop = (e: React.DragEvent, targetTabId: string) => {
    e.preventDefault()

    if (!draggedTabId || draggedTabId === targetTabId) return

    const fromIndex = openTabs.findIndex((tab) => tab.id === draggedTabId)
    const toIndex = openTabs.findIndex((tab) => tab.id === targetTabId)

    if (fromIndex !== -1 && toIndex !== -1) {
      reorderTabs(fromIndex, toIndex)
    }

    setDraggedTabId(null)
    setDragOverTabId(null)
  }

  // =========================================================================
  // 右键菜单处理
  // =========================================================================

  /**
   * 处理右键点击
   */
  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    e.stopPropagation()

    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      tabId,
    })
  }

  /**
   * 关闭右键菜单
   */
  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

  /**
   * 处理菜单项点击
   */
  const handleMenuAction = (action: 'close' | 'closeOthers' | 'closeAll') => {
    const tabId = contextMenu.tabId
    closeContextMenu()

    if (!tabId) return

    switch (action) {
      case 'close':
        closeTab(tabId)
        break
      case 'closeOthers':
        closeOtherTabs(tabId)
        break
      case 'closeAll':
        closeAllTabs()
        break
    }
  }

  /**
   * 点击外部关闭菜单
   */
  useEffect(() => {
    if (!contextMenu.visible) return

    const handleClickOutside = () => closeContextMenu()
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu()
    }

    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu.visible, closeContextMenu])

  /**
   * 获取标签页图标
   */
  const getTabIcon = () => {
    // TODO: 根据文件类型返回不同图标
    return <FileCode className="w-4 h-4" />
  }

  if (openTabs.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'relative flex items-center h-9 bg-muted/30 border-b border-border',
        'min-w-0 overflow-hidden',
        className
      )}
    >
      {/* 左滚动按钮 */}
      {canScrollLeft && (
        <button
          className={cn(
            'absolute left-0 z-10 flex items-center justify-center',
            'w-6 h-full bg-gradient-to-r from-muted/80 to-transparent',
            'hover:from-muted transition-colors'
          )}
          onClick={() => scrollTabs('left')}
          aria-label="向左滚动"
        >
          <ChevronLeft className="w-4 h-4 text-muted-foreground" />
        </button>
      )}

      {/* 标签页容器 */}
      <div
        ref={tabsContainerRef}
        className={cn(
          'flex items-center h-full flex-1 min-w-0 overflow-x-auto',
          'scrollbar-none',
          canScrollLeft && 'pl-6',
          canScrollRight && 'pr-6'
        )}
        role="tablist"
      >
        {openTabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const isDragging = tab.id === draggedTabId
          const isDragOver = tab.id === dragOverTabId

          return (
            <div
              key={tab.id}
              className={cn(
                'group flex items-center gap-1.5 h-full px-3 cursor-pointer',
                'border-r border-border flex-shrink-0',
                'hover:bg-muted/50 transition-colors',
                isActive
                  ? 'bg-background border-t-2 border-t-primary'
                  : 'bg-transparent',
                isDragging && 'opacity-50',
                isDragOver && 'border-l-2 border-l-primary'
              )}
              onClick={() => handleTabClick(tab.id)}
              onMouseDown={(e) => handleMouseDown(e, tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              // 拖拽属性
              draggable
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, tab.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, tab.id)}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
            >
              {/* 文件图标 */}
              <span className="text-muted-foreground">{getTabIcon()}</span>

              {/* 文件名 */}
              <span
                className={cn(
                  'text-sm whitespace-nowrap select-none',
                  isActive ? 'text-foreground' : 'text-muted-foreground',
                  tab.dirty && 'italic'
                )}
              >
                {tab.title}
                {tab.dirty && <span className="ml-0.5">•</span>}
              </span>

              {/* 关闭按钮 */}
              <button
                className={cn(
                  'ml-1 p-0.5 rounded',
                  'opacity-0 group-hover:opacity-100',
                  'hover:bg-muted-foreground/20 transition-opacity',
                  isActive && 'opacity-100'
                )}
                onClick={(e) => handleCloseTab(e, tab.id)}
                aria-label={`关闭 ${tab.title}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>

      {/* 右滚动按钮 */}
      {canScrollRight && (
        <button
          className={cn(
            'absolute right-0 z-10 flex items-center justify-center',
            'w-6 h-full bg-gradient-to-l from-muted/80 to-transparent',
            'hover:from-muted transition-colors'
          )}
          onClick={() => scrollTabs('right')}
          aria-label="向右滚动"
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </button>
      )}

      {/* 右键上下文菜单 */}
      {contextMenu.visible && (
        <div
          className={cn(
            'fixed z-50 min-w-[160px] overflow-hidden rounded-md border',
            'bg-popover p-1 text-popover-foreground shadow-md',
            'animate-in fade-in-0 zoom-in-95'
          )}
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={cn(
              'relative flex w-full cursor-default select-none items-center',
              'rounded-sm px-2 py-1.5 text-sm outline-none',
              'hover:bg-accent hover:text-accent-foreground',
              'transition-colors'
            )}
            onClick={() => handleMenuAction('close')}
          >
            关闭
          </button>
          <button
            className={cn(
              'relative flex w-full cursor-default select-none items-center',
              'rounded-sm px-2 py-1.5 text-sm outline-none',
              'hover:bg-accent hover:text-accent-foreground',
              'transition-colors',
              openTabs.length <= 1 && 'opacity-50 pointer-events-none'
            )}
            onClick={() => handleMenuAction('closeOthers')}
            disabled={openTabs.length <= 1}
          >
            关闭其他
          </button>
          <div className="-mx-1 my-1 h-px bg-muted" />
          <button
            className={cn(
              'relative flex w-full cursor-default select-none items-center',
              'rounded-sm px-2 py-1.5 text-sm outline-none',
              'hover:bg-accent hover:text-accent-foreground',
              'transition-colors'
            )}
            onClick={() => handleMenuAction('closeAll')}
          >
            关闭所有
          </button>
        </div>
      )}
    </div>
  )
}
