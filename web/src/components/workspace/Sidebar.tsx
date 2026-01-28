import { Suspense } from 'react'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, SIDEBAR_MIN_WIDTH } from '@/stores/workspaceStore'
import { FileExplorer } from './FileExplorer'
import { 
  LazySearchPanel, 
  LazyGitPanel, 
  PanelLoadingFallback 
} from './LazyComponents'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Sidebar 组件属性
 */
export interface SidebarProps {
  /** 工作区路径 */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
}

/**
 * 视图配置映射
 */
const VIEW_CONFIG = {
  explorer: {
    title: '资源管理器',
    titleKey: 'EXPLORER',
  },
  search: {
    title: '搜索',
    titleKey: 'SEARCH',
  },
  git: {
    title: '源代码管理',
    titleKey: 'SOURCE CONTROL',
  },
  terminal: {
    title: '资源管理器',
    titleKey: 'EXPLORER',
  },
} as const

/**
 * Sidebar - 侧边栏组件
 *
 * 根据当前激活的视图显示不同的面板内容：
 * - explorer: 文件资源管理器
 * - search: 搜索面板
 * - git: Git 面板
 * - terminal: 终端（显示在底部面板，侧边栏显示文件资源管理器）
 *
 * 特性：
 * - 支持展开/折叠动画（300ms ease-out）
 * - 宽度可通过 ResizeHandle 拖拽调整
 * - 标题栏显示当前视图名称
 */
export function Sidebar({ workspacePath, className }: SidebarProps) {
  const activeView = useWorkspaceStore((state) => state.activeView)
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const sidebarWidth = useWorkspaceStore((state) => state.sidebarWidth)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)

  // 获取当前视图配置
  const viewConfig = VIEW_CONFIG[activeView] || VIEW_CONFIG.explorer

  // 根据当前视图渲染对应的面板（使用懒加载）
  const renderPanel = () => {
    switch (activeView) {
      case 'explorer':
        return <FileExplorer workspacePath={workspacePath} />
      case 'search':
        return (
          <Suspense fallback={<PanelLoadingFallback />}>
            <LazySearchPanel workspacePath={workspacePath} />
          </Suspense>
        )
      case 'git':
        return (
          <Suspense fallback={<PanelLoadingFallback />}>
            <LazyGitPanel workspacePath={workspacePath} />
          </Suspense>
        )
      case 'terminal':
        // 终端视图时显示文件资源管理器
        return <FileExplorer workspacePath={workspacePath} />
      default:
        return <FileExplorer workspacePath={workspacePath} />
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col bg-background border-r border-border overflow-hidden',
        // 展开/折叠动画：300ms ease-out
        'transition-[width,min-width,opacity] duration-300 ease-out',
        className
      )}
      style={{
        // 使用 CSS 变量控制宽度，支持动画过渡
        width: sidebarVisible ? sidebarWidth : 0,
        minWidth: sidebarVisible ? SIDEBAR_MIN_WIDTH : 0,
        // 折叠时隐藏内容
        opacity: sidebarVisible ? 1 : 0,
      }}
      aria-hidden={!sidebarVisible}
      aria-label="侧边栏"
    >
      {/* 侧边栏标题栏 */}
      <SidebarHeader
        title={viewConfig.title}
        titleKey={viewConfig.titleKey}
        onToggle={toggleSidebar}
        isCollapsed={!sidebarVisible}
      />

      {/* 面板内容 */}
      <div
        className={cn(
          'flex-1 overflow-auto',
          // 内容淡入淡出动画
          'transition-opacity duration-200 ease-out',
          sidebarVisible ? 'opacity-100' : 'opacity-0'
        )}
      >
        {renderPanel()}
      </div>
    </div>
  )
}

/**
 * SidebarHeader 组件属性
 */
interface SidebarHeaderProps {
  /** 显示标题 */
  title: string
  /** 标题键（大写英文） */
  titleKey: string
  /** 切换折叠状态回调 */
  onToggle: () => void
  /** 是否已折叠 */
  isCollapsed: boolean
}

/**
 * SidebarHeader - 侧边栏标题栏组件
 *
 * 显示当前视图名称，并提供折叠/展开按钮
 */
function SidebarHeader({ title, titleKey, onToggle, isCollapsed }: SidebarHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between h-9 px-4',
        'border-b border-border',
        'bg-background/50 backdrop-blur-sm',
        'select-none'
      )}
    >
      {/* 标题 */}
      <span
        className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider truncate"
        title={title}
      >
        {titleKey}
      </span>

      {/* 折叠/展开按钮 */}
      <button
        onClick={onToggle}
        className={cn(
          'flex items-center justify-center',
          'w-5 h-5 rounded-sm',
          'text-muted-foreground hover:text-foreground',
          'hover:bg-muted/50',
          'transition-colors duration-150',
          'focus:outline-none focus:ring-1 focus:ring-ring'
        )}
        aria-label={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
        title={isCollapsed ? '展开侧边栏 (Ctrl+B)' : '折叠侧边栏 (Ctrl+B)'}
      >
        {isCollapsed ? (
          <ChevronRight className="w-4 h-4" />
        ) : (
          <ChevronLeft className="w-4 h-4" />
        )}
      </button>
    </div>
  )
}

/**
 * 导出 SidebarHeader 供外部使用
 */
export { SidebarHeader }
