/**
 * 懒加载组件
 * 
 * 使用 React.lazy 和 Suspense 实现组件懒加载，
 * 减少初始加载时间，提升性能。
 */

import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'

// ============================================================================
// 加载占位组件
// ============================================================================

interface LoadingFallbackProps {
  /** 自定义类名 */
  className?: string
  /** 加载提示文本 */
  text?: string
  /** 是否显示加载图标 */
  showIcon?: boolean
}

/**
 * LoadingFallback - 加载占位组件
 */
export function LoadingFallback({ 
  className, 
  text = '加载中...', 
  showIcon = true 
}: LoadingFallbackProps) {
  return (
    <div className={cn(
      'flex items-center justify-center h-full w-full',
      'text-sm text-muted-foreground',
      className
    )}>
      {showIcon && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
      <span>{text}</span>
    </div>
  )
}

/**
 * 面板加载占位
 */
export function PanelLoadingFallback() {
  return <LoadingFallback className="min-h-[100px]" />
}

/**
 * 编辑器加载占位
 */
export function EditorLoadingFallback() {
  return <LoadingFallback className="min-h-[200px]" text="编辑器加载中..." />
}

// ============================================================================
// 懒加载组件包装器
// ============================================================================

interface LazyWrapperProps {
  children: ReactNode
  fallback?: ReactNode
}

/**
 * LazyWrapper - 懒加载包装器
 */
export function LazyWrapper({ children, fallback }: LazyWrapperProps) {
  return (
    <Suspense fallback={fallback || <LoadingFallback />}>
      {children}
    </Suspense>
  )
}

// ============================================================================
// 懒加载组件定义
// ============================================================================

/**
 * 懒加载 GitPanel
 */
export const LazyGitPanel = lazy(() => 
  import('./GitPanel').then(module => ({ default: module.GitPanel }))
)

/**
 * 懒加载 SearchPanel
 */
export const LazySearchPanel = lazy(() => 
  import('./SearchPanel').then(module => ({ default: module.SearchPanel }))
)

/**
 * 懒加载 TerminalPanel
 */
export const LazyTerminalPanel = lazy(() => 
  import('./TerminalPanel').then(module => ({ default: module.TerminalPanel }))
)

/**
 * 懒加载 OutputPanel
 */
export const LazyOutputPanel = lazy(() => 
  import('./OutputPanel').then(module => ({ default: module.OutputPanel }))
)

/**
 * 懒加载 QuickOpen
 */
export const LazyQuickOpen = lazy(() => 
  import('./QuickOpen').then(module => ({ default: module.QuickOpen }))
)

/**
 * 懒加载 EditorContent
 */
export const LazyEditorContent = lazy(() => 
  import('./EditorContent').then(module => ({ default: module.EditorContent }))
)

/**
 * 懒加载 KeyboardShortcutsHelp
 */
export const LazyKeyboardShortcutsHelp = lazy(() => 
  import('./KeyboardShortcutsHelp').then(module => ({ default: module.KeyboardShortcutsHelp }))
)

// ============================================================================
// 带 Suspense 的懒加载组件
// ============================================================================

/**
 * 创建带 Suspense 的懒加载组件
 */
function withSuspense<P extends object>(
  LazyComponent: ComponentType<P>,
  fallback?: ReactNode
) {
  return function SuspenseWrapper(props: P) {
    return (
      <Suspense fallback={fallback || <LoadingFallback />}>
        <LazyComponent {...props} />
      </Suspense>
    )
  }
}

/**
 * 带 Suspense 的 GitPanel
 */
export const SuspenseGitPanel = withSuspense(
  LazyGitPanel as ComponentType<{ workspacePath?: string; className?: string }>,
  <PanelLoadingFallback />
)

/**
 * 带 Suspense 的 SearchPanel
 */
export const SuspenseSearchPanel = withSuspense(
  LazySearchPanel as ComponentType<{ workspacePath?: string; className?: string }>,
  <PanelLoadingFallback />
)

/**
 * 带 Suspense 的 TerminalPanel
 */
export const SuspenseTerminalPanel = withSuspense(LazyTerminalPanel, <PanelLoadingFallback />)

/**
 * 带 Suspense 的 OutputPanel
 */
export const SuspenseOutputPanel = withSuspense(LazyOutputPanel, <PanelLoadingFallback />)
