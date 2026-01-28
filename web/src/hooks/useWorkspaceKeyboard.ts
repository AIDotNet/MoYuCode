import { useEffect, useCallback } from 'react'
import { useWorkspaceStore } from '@/stores/workspaceStore'

/**
 * 快捷键定义接口
 */
export interface ShortcutDefinition {
  /** 按键（小写） */
  key: string
  /** 是否需要 Ctrl/Cmd */
  ctrl: boolean
  /** 是否需要 Shift */
  shift: boolean
  /** 是否需要 Alt */
  alt?: boolean
  /** 快捷键描述 */
  description: string
  /** 显示用的快捷键文本 */
  displayText: string
}

/**
 * 工作区快捷键配置
 */
const SHORTCUTS: Record<string, ShortcutDefinition> = {
  // 快速打开文件
  quickOpen: {
    key: 'p',
    ctrl: true,
    shift: false,
    description: '快速打开文件',
    displayText: 'Ctrl+P',
  },
  // 切换侧边栏
  toggleSidebar: {
    key: 'b',
    ctrl: true,
    shift: false,
    description: '切换侧边栏',
    displayText: 'Ctrl+B',
  },
  // 切换底部面板
  togglePanel: {
    key: 'j',
    ctrl: true,
    shift: false,
    description: '切换底部面板',
    displayText: 'Ctrl+J',
  },
  // 关闭当前标签页
  closeTab: {
    key: 'w',
    ctrl: true,
    shift: false,
    description: '关闭当前标签页',
    displayText: 'Ctrl+W',
  },
  // 切换到下一个标签页
  nextTab: {
    key: 'Tab',
    ctrl: true,
    shift: false,
    description: '切换到下一个标签页',
    displayText: 'Ctrl+Tab',
  },
  // 切换到上一个标签页
  prevTab: {
    key: 'Tab',
    ctrl: true,
    shift: true,
    description: '切换到上一个标签页',
    displayText: 'Ctrl+Shift+Tab',
  },
  // 切换到文件资源管理器
  focusExplorer: {
    key: 'e',
    ctrl: true,
    shift: true,
    description: '聚焦文件资源管理器',
    displayText: 'Ctrl+Shift+E',
  },
  // 切换到搜索面板
  focusSearch: {
    key: 'f',
    ctrl: true,
    shift: true,
    description: '打开搜索面板',
    displayText: 'Ctrl+Shift+F',
  },
  // 切换到 Git 面板
  focusGit: {
    key: 'g',
    ctrl: true,
    shift: true,
    description: '打开 Git 面板',
    displayText: 'Ctrl+Shift+G',
  },
  // 切换终端
  toggleTerminal: {
    key: '`',
    ctrl: true,
    shift: false,
    description: '切换终端面板',
    displayText: 'Ctrl+`',
  },
  // 新建终端
  newTerminal: {
    key: '`',
    ctrl: true,
    shift: true,
    description: '新建终端',
    displayText: 'Ctrl+Shift+`',
  },
} as const

/**
 * 检查快捷键是否匹配
 */
function matchShortcut(
  e: KeyboardEvent,
  shortcut: ShortcutDefinition
): boolean {
  const ctrlOrMeta = e.ctrlKey || e.metaKey
  const altKey = shortcut.alt ?? false
  return (
    e.key.toLowerCase() === shortcut.key.toLowerCase() &&
    ctrlOrMeta === shortcut.ctrl &&
    e.shiftKey === shortcut.shift &&
    e.altKey === altKey
  )
}

/**
 * 检查是否在 Monaco Editor 内部
 * Monaco Editor 有自己的快捷键系统，某些快捷键需要让 Monaco 处理
 */
function isInMonacoEditor(target: HTMLElement): boolean {
  // Monaco Editor 的容器类名
  return (
    target.closest('.monaco-editor') !== null ||
    target.classList.contains('monaco-editor') ||
    target.closest('[data-monaco-editor]') !== null
  )
}

/**
 * 检查是否应该让 Monaco Editor 处理该快捷键
 * 某些快捷键（如 Ctrl+F 查找）应该让 Monaco 处理
 */
function shouldMonacoHandle(e: KeyboardEvent): boolean {
  const ctrlOrMeta = e.ctrlKey || e.metaKey
  
  // Monaco 应该处理的快捷键列表
  const monacoShortcuts = [
    // 查找/替换
    { key: 'f', ctrl: true, shift: false }, // Ctrl+F 查找
    { key: 'h', ctrl: true, shift: false }, // Ctrl+H 替换
    // 编辑操作
    { key: 'z', ctrl: true, shift: false }, // Ctrl+Z 撤销
    { key: 'y', ctrl: true, shift: false }, // Ctrl+Y 重做
    { key: 'z', ctrl: true, shift: true },  // Ctrl+Shift+Z 重做
    // 选择操作
    { key: 'a', ctrl: true, shift: false }, // Ctrl+A 全选
    { key: 'd', ctrl: true, shift: false }, // Ctrl+D 选择下一个匹配
    // 行操作
    { key: 'l', ctrl: true, shift: false }, // Ctrl+L 选择行
    { key: '/', ctrl: true, shift: false }, // Ctrl+/ 注释
  ]

  return monacoShortcuts.some(
    (shortcut) =>
      e.key.toLowerCase() === shortcut.key &&
      ctrlOrMeta === shortcut.ctrl &&
      e.shiftKey === shortcut.shift
  )
}

/**
 * 获取所有快捷键列表（用于显示）
 */
export function getShortcutsList(): Array<{ id: string; shortcut: ShortcutDefinition }> {
  return Object.entries(SHORTCUTS).map(([id, shortcut]) => ({
    id,
    shortcut,
  }))
}

/**
 * 根据 ID 获取快捷键定义
 */
export function getShortcutById(id: string): ShortcutDefinition | undefined {
  return SHORTCUTS[id]
}


/**
 * useWorkspaceKeyboard - 工作区快捷键 Hook
 *
 * 注册全局快捷键，支持：
 * - Ctrl+P: 快速打开文件
 * - Ctrl+B: 切换侧边栏
 * - Ctrl+J: 切换底部面板
 * - Ctrl+W: 关闭当前标签页
 * - Ctrl+Tab: 切换到下一个标签页
 * - Ctrl+Shift+Tab: 切换到上一个标签页
 * - Ctrl+Shift+E: 聚焦文件资源管理器
 * - Ctrl+Shift+F: 聚焦搜索面板
 * - Ctrl+Shift+G: 聚焦 Git 面板
 * - Ctrl+`: 切换终端
 * - Ctrl+Shift+`: 新建终端
 */
export function useWorkspaceKeyboard() {
  // 从 store 获取 actions
  const toggleQuickOpen = useWorkspaceStore((state) => state.toggleQuickOpen)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)
  const togglePanel = useWorkspaceStore((state) => state.togglePanel)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)
  const setSidebarVisible = useWorkspaceStore((state) => state.setSidebarVisible)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const openTabs = useWorkspaceStore((state) => state.openTabs)
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      
      // 检查是否在输入框中
      const isInput = 
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable

      // 检查是否在 Monaco Editor 中
      const inMonaco = isInMonacoEditor(target)

      // 如果在 Monaco 中且是 Monaco 应该处理的快捷键，不拦截
      if (inMonaco && shouldMonacoHandle(e)) {
        return
      }

      // Ctrl+P 快速打开（在任何地方都生效，包括 Monaco）
      if (matchShortcut(e, SHORTCUTS.quickOpen)) {
        e.preventDefault()
        e.stopPropagation()
        toggleQuickOpen()
        return
      }

      // Ctrl+Tab / Ctrl+Shift+Tab 标签页切换（在任何地方都生效）
      if (matchShortcut(e, SHORTCUTS.nextTab)) {
        e.preventDefault()
        e.stopPropagation()
        if (openTabs.length > 1 && activeTabId) {
          const currentIndex = openTabs.findIndex((tab) => tab.id === activeTabId)
          const nextIndex = (currentIndex + 1) % openTabs.length
          setActiveTab(openTabs[nextIndex].id)
        }
        return
      }

      if (matchShortcut(e, SHORTCUTS.prevTab)) {
        e.preventDefault()
        e.stopPropagation()
        if (openTabs.length > 1 && activeTabId) {
          const currentIndex = openTabs.findIndex((tab) => tab.id === activeTabId)
          const prevIndex = (currentIndex - 1 + openTabs.length) % openTabs.length
          setActiveTab(openTabs[prevIndex].id)
        }
        return
      }

      // 如果在输入框中（非 Monaco），不处理其他快捷键
      if (isInput && !inMonaco) return

      // Ctrl+B 切换侧边栏
      if (matchShortcut(e, SHORTCUTS.toggleSidebar)) {
        e.preventDefault()
        e.stopPropagation()
        toggleSidebar()
        return
      }

      // Ctrl+J 切换底部面板
      if (matchShortcut(e, SHORTCUTS.togglePanel)) {
        e.preventDefault()
        e.stopPropagation()
        togglePanel()
        return
      }

      // Ctrl+W 关闭当前标签页
      if (matchShortcut(e, SHORTCUTS.closeTab)) {
        e.preventDefault()
        e.stopPropagation()
        if (activeTabId) {
          closeTab(activeTabId)
        }
        return
      }

      // Ctrl+Shift+E 聚焦文件资源管理器
      if (matchShortcut(e, SHORTCUTS.focusExplorer)) {
        e.preventDefault()
        e.stopPropagation()
        setActiveView('explorer')
        setSidebarVisible(true)
        return
      }

      // Ctrl+Shift+F 聚焦搜索面板
      if (matchShortcut(e, SHORTCUTS.focusSearch)) {
        e.preventDefault()
        e.stopPropagation()
        setActiveView('search')
        setSidebarVisible(true)
        return
      }

      // Ctrl+Shift+G 聚焦 Git 面板
      if (matchShortcut(e, SHORTCUTS.focusGit)) {
        e.preventDefault()
        e.stopPropagation()
        setActiveView('git')
        setSidebarVisible(true)
        return
      }

      // Ctrl+` 切换终端
      if (matchShortcut(e, SHORTCUTS.toggleTerminal)) {
        e.preventDefault()
        e.stopPropagation()
        togglePanel()
        return
      }

      // Ctrl+Shift+` 新建终端
      if (matchShortcut(e, SHORTCUTS.newTerminal)) {
        e.preventDefault()
        e.stopPropagation()
        createTerminal()
        return
      }
    },
    [
      toggleQuickOpen,
      toggleSidebar,
      togglePanel,
      closeTab,
      setActiveView,
      setSidebarVisible,
      createTerminal,
      activeTabId,
      openTabs,
      setActiveTab,
    ]
  )

  useEffect(() => {
    // 使用 capture 阶段确保在其他处理器之前执行
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [handleKeyDown])
}

export { SHORTCUTS }
