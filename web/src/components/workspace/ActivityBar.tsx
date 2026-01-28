import { cn } from '@/lib/utils'
import {
  Files,
  Search,
  GitBranch,
  Terminal,
  Keyboard,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { useState, useMemo } from 'react'
import { useWorkspaceStore, type ActiveView } from '@/stores/workspaceStore'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'

/**
 * 活动栏项目配置
 */
interface ActivityItem {
  id: ActiveView
  icon: LucideIcon
  label: string
  shortcut: string
  /** 是否是面板控制（如终端） */
  isPanel?: boolean
}

/**
 * 活动栏项目列表 - 侧边栏视图
 */
const sidebarItems: ActivityItem[] = [
  { id: 'explorer', icon: Files, label: '资源管理器', shortcut: 'Ctrl+Shift+E' },
  { id: 'search', icon: Search, label: '搜索', shortcut: 'Ctrl+Shift+F' },
  { id: 'git', icon: GitBranch, label: '源代码管理', shortcut: 'Ctrl+Shift+G' },
]

/**
 * 活动栏项目列表 - 面板控制
 */
const panelItems: ActivityItem[] = [
  { id: 'terminal', icon: Terminal, label: '终端', shortcut: 'Ctrl+`', isPanel: true },
]

/**
 * ActivityBar 组件属性
 */
export interface ActivityBarProps {
  /** 自定义类名 */
  className?: string
}

/**
 * ActivityBarItem - 单个活动栏按钮组件
 */
interface ActivityBarItemProps {
  item: ActivityItem
  isActive: boolean
  onClick: () => void
}

function ActivityBarItem({ item, isActive, onClick }: ActivityBarItemProps) {
  const Icon = item.icon

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            'relative w-full h-12 flex items-center justify-center',
            'group transition-all duration-200 ease-out',
            // 默认状态
            'text-muted-foreground/70',
            // 悬停状态
            'hover:text-foreground hover:bg-muted/40',
            // 激活状态
            isActive && 'text-foreground'
          )}
          onClick={onClick}
          role="tab"
          aria-selected={isActive}
          aria-controls={`${item.id}-panel`}
          tabIndex={isActive ? 0 : -1}
          id={`${item.id}-tab`}
        >
          {/* 激活状态指示器 - 带动画的左侧色条 */}
          <div
            className={cn(
              'absolute left-0 top-1/2 -translate-y-1/2 w-[2px] rounded-r',
              'bg-primary transition-all duration-200 ease-out',
              isActive ? 'h-6 opacity-100' : 'h-0 opacity-0'
            )}
            aria-hidden="true"
          />

          {/* 图标容器 - 带悬停缩放效果 */}
          <div
            className={cn(
              'relative flex items-center justify-center',
              'w-10 h-10 rounded-lg',
              'transition-all duration-200 ease-out',
              // 悬停时的背景
              'group-hover:bg-muted/60',
              // 激活时的背景
              isActive && 'bg-muted/40'
            )}
          >
            <Icon
              className={cn(
                'w-[22px] h-[22px]',
                'transition-transform duration-200 ease-out',
                'group-hover:scale-110',
                isActive && 'scale-105'
              )}
              strokeWidth={isActive ? 2 : 1.5}
              aria-hidden="true"
            />
          </div>

          <span className="sr-only">{item.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={12}
        className="flex flex-col gap-0.5"
      >
        <span className="font-medium">{item.label}</span>
        <span className="text-[10px] text-muted-foreground">{item.shortcut}</span>
      </TooltipContent>
    </Tooltip>
  )
}


/**
 * ActivityBar - 活动栏组件
 *
 * 位于工作区最左侧，提供视图切换功能。
 *
 * 功能特性：
 * - 视图切换：点击图标切换不同视图
 * - 激活指示器：左侧带动画的主题色条
 * - 图标动画：悬停缩放、背景渐变
 * - Tooltip 提示：悬停显示名称和快捷键
 * - 分组布局：侧边栏视图 + 面板控制 + 工具按钮
 *
 * 样式规范：
 * - 宽度：48px (w-12)
 * - 图标大小：22px
 * - 背景色：bg-muted/20
 */
export function ActivityBar({ className }: ActivityBarProps) {
  const activeView = useWorkspaceStore((state) => state.activeView)
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const setSidebarVisible = useWorkspaceStore((state) => state.setSidebarVisible)
  const panelVisible = useWorkspaceStore((state) => state.panelVisible)
  const setPanelVisible = useWorkspaceStore((state) => state.setPanelVisible)
  const setActivePanelTab = useWorkspaceStore((state) => state.setActivePanelTab)
  const activePanelTab = useWorkspaceStore((state) => state.activePanelTab)
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false)

  /**
   * 处理侧边栏视图切换
   */
  const handleSidebarViewClick = (viewId: ActiveView) => {
    if (activeView === viewId && sidebarVisible) {
      // 点击当前激活的视图，切换侧边栏
      setSidebarVisible(false)
    } else {
      // 切换到该视图并确保侧边栏展开
      setActiveView(viewId)
      setSidebarVisible(true)
    }
  }

  /**
   * 处理面板控制点击（如终端）
   */
  const handlePanelClick = (viewId: ActiveView) => {
    if (viewId === 'terminal') {
      if (panelVisible && activePanelTab === 'terminal') {
        setPanelVisible(false)
      } else {
        setPanelVisible(true)
        setActivePanelTab('terminal')
      }
    }
  }

  /**
   * 判断面板项是否激活
   */
  const isPanelItemActive = (itemId: ActiveView) => {
    if (itemId === 'terminal') {
      return panelVisible && activePanelTab === 'terminal'
    }
    return false
  }

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className={cn(
          'flex flex-col items-center w-12',
          'bg-muted/20 border-r border-border/50',
          className
        )}
        role="tablist"
        aria-label="活动栏"
        aria-orientation="vertical"
      >
        {/* 侧边栏视图按钮 */}
        <div className="flex flex-col w-full pt-1">
          {sidebarItems.map((item) => (
            <ActivityBarItem
              key={item.id}
              item={item}
              isActive={activeView === item.id && sidebarVisible}
              onClick={() => handleSidebarViewClick(item.id)}
            />
          ))}
        </div>

        {/* 分隔线 */}
        <div className="w-6 h-px bg-border/50 my-2" />

        {/* 面板控制按钮 */}
        <div className="flex flex-col w-full">
          {panelItems.map((item) => (
            <ActivityBarItem
              key={item.id}
              item={item}
              isActive={isPanelItemActive(item.id)}
              onClick={() => handlePanelClick(item.id)}
            />
          ))}
        </div>

        {/* 弹性空间 */}
        <div className="flex-1" />

        {/* 底部工具按钮 */}
        <div className="flex flex-col w-full pb-2">
          {/* 快捷键帮助 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  'relative w-full h-12 flex items-center justify-center',
                  'group transition-all duration-200 ease-out',
                  'text-muted-foreground/70',
                  'hover:text-foreground hover:bg-muted/40'
                )}
                onClick={() => setShortcutsHelpOpen(true)}
              >
                <div
                  className={cn(
                    'flex items-center justify-center',
                    'w-10 h-10 rounded-lg',
                    'transition-all duration-200 ease-out',
                    'group-hover:bg-muted/60'
                  )}
                >
                  <Keyboard
                    className="w-5 h-5 transition-transform duration-200 group-hover:scale-110"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </div>
                <span className="sr-only">快捷键帮助</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={12}>
              <span className="font-medium">快捷键帮助</span>
              <span className="text-[10px] text-muted-foreground ml-2">F1</span>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* 快捷键帮助弹窗 */}
        <KeyboardShortcutsHelp
          showTrigger={false}
          open={shortcutsHelpOpen}
          onOpenChange={setShortcutsHelpOpen}
        />
      </nav>
    </TooltipProvider>
  )
}
