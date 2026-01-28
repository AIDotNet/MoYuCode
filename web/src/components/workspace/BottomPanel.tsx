import { Suspense } from 'react'
import { cn } from '@/lib/utils'
import { Terminal, FileOutput, AlertCircle, ChevronDown, X } from 'lucide-react'
import { useWorkspaceStore, type PanelTab } from '@/stores/workspaceStore'
import { 
  LazyTerminalPanel, 
  LazyOutputPanel, 
  PanelLoadingFallback 
} from './LazyComponents'

/**
 * 面板标签配置
 */
interface PanelTabConfig {
  id: PanelTab
  label: string
  icon: React.ReactNode
}

/**
 * 面板标签列表
 */
const panelTabs: PanelTabConfig[] = [
  { id: 'terminal', label: '终端', icon: <Terminal className="w-4 h-4" /> },
  { id: 'output', label: '输出', icon: <FileOutput className="w-4 h-4" /> },
  { id: 'problems', label: '问题', icon: <AlertCircle className="w-4 h-4" /> },
]

/**
 * BottomPanel 组件属性
 */
export interface BottomPanelProps {
  /** 工作区路径 */
  workspacePath?: string
  /** 自定义类名 */
  className?: string
}

/**
 * BottomPanel - 底部面板组件
 *
 * 包含终端、输出、问题等面板，支持：
 * - 面板标签切换
 * - 面板展开/折叠
 * - 高度拖拽调整
 */
export function BottomPanel({ workspacePath, className }: BottomPanelProps) {
  const panelVisible = useWorkspaceStore((state) => state.panelVisible)
  const panelHeight = useWorkspaceStore((state) => state.panelHeight)
  const activePanelTab = useWorkspaceStore((state) => state.activePanelTab)
  const setActivePanelTab = useWorkspaceStore((state) => state.setActivePanelTab)
  const togglePanel = useWorkspaceStore((state) => state.togglePanel)

  // 如果面板不可见，不渲染
  if (!panelVisible) {
    return null
  }

  /**
   * 渲染面板内容（使用懒加载）
   */
  const renderPanelContent = () => {
    switch (activePanelTab) {
      case 'terminal':
        return (
          <Suspense fallback={<PanelLoadingFallback />}>
            <LazyTerminalPanel workspacePath={workspacePath} />
          </Suspense>
        )
      case 'output':
        return (
          <Suspense fallback={<PanelLoadingFallback />}>
            <LazyOutputPanel />
          </Suspense>
        )
      case 'problems':
        return (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            暂无问题
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div
      className={cn('flex flex-col bg-background border-t border-border', className)}
      style={{ height: panelHeight }}
    >
      {/* 面板标签栏 */}
      <div className="flex items-center justify-between h-9 px-2 bg-muted/30 border-b border-border">
        {/* 标签列表 */}
        <div className="flex items-center gap-1">
          {panelTabs.map((tab) => {
            const isActive = activePanelTab === tab.id

            return (
              <button
                key={tab.id}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 text-sm rounded',
                  'transition-colors duration-150',
                  isActive
                    ? 'text-foreground bg-muted'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
                onClick={() => setActivePanelTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1">
          <button
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
            onClick={togglePanel}
            aria-label="最小化面板"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
          <button
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
            onClick={togglePanel}
            aria-label="关闭面板"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 面板内容 */}
      <div className="flex-1 overflow-hidden">{renderPanelContent()}</div>
    </div>
  )
}
