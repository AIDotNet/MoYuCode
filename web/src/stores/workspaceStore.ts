import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 活动栏视图类型
 */
export type ActiveView = 'explorer' | 'search' | 'git' | 'terminal'

/**
 * 底部面板标签类型
 */
export type PanelTab = 'terminal' | 'output' | 'problems'

/**
 * 编辑器标签页类型
 */
export interface EditorTab {
  /** 唯一标识符 */
  id: string
  /** 标签页类型 */
  kind: 'file' | 'diff' | 'preview' | 'welcome'
  /** 显示标题 */
  title: string
  /** 文件路径（仅 file 类型） */
  path?: string
  /** 是否有未保存的修改 */
  dirty?: boolean
  /** 文件图标 URL */
  iconUrl?: string
}

/**
 * 终端实例类型
 */
export interface TerminalInstance {
  /** 唯一标识符 */
  id: string
  /** 终端标题 */
  title: string
  /** 当前工作目录 */
  cwd: string
  /** 连接状态 */
  status: 'connecting' | 'connected' | 'closed' | 'error'
}

/**
 * 搜索结果类型
 */
export interface SearchResult {
  /** 文件路径 */
  filePath: string
  /** 行号 */
  lineNumber: number
  /** 行内容 */
  lineContent: string
  /** 匹配开始位置 */
  matchStart: number
  /** 匹配结束位置 */
  matchEnd: number
}

/**
 * 文件索引条目类型
 */
export interface FileIndexEntry {
  /** 文件名 */
  name: string
  /** 完整路径 */
  fullPath: string
  /** 相对路径（相对于工作区根目录） */
  relativePath: string
}

/**
 * 输出项类型
 */
export type OutputType = 'info' | 'warning' | 'error' | 'success' | 'tool'

/**
 * 输出项接口
 */
export interface OutputItem {
  /** 唯一标识符 */
  id: string
  /** 时间戳 */
  timestamp: Date
  /** 输出类型 */
  type: OutputType
  /** 输出内容 */
  content: string
  /** 来源 */
  source?: string
  /** 工具名称（仅 tool 类型） */
  toolName?: string
  /** 工具参数（仅 tool 类型） */
  toolArgs?: Record<string, unknown>
  /** 工具执行结果（仅 tool 类型） */
  toolResult?: string
  /** 工具执行状态（仅 tool 类型） */
  toolStatus?: 'running' | 'success' | 'error'
}

/**
 * 代码选择信息
 */
export interface CodeSelectionInfo {
  /** 文件路径 */
  filePath: string
  /** 起始行号 */
  startLine: number
  /** 结束行号 */
  endLine: number
  /** 选中的代码文本 */
  text: string
}

// ============================================================================
// 布局约束常量
// ============================================================================

/** 侧边栏最小宽度 (px) */
export const SIDEBAR_MIN_WIDTH = 200

/** 侧边栏最大宽度比例 (相对于容器宽度) */
export const SIDEBAR_MAX_WIDTH_RATIO = 0.5

/** 侧边栏默认宽度 (px) */
export const SIDEBAR_DEFAULT_WIDTH = 280

/** 底部面板最小高度 (px) */
export const PANEL_MIN_HEIGHT = 100

/** 底部面板最大高度比例 (相对于容器高度) */
export const PANEL_MAX_HEIGHT_RATIO = 0.7

/** 底部面板默认高度 (px) */
export const PANEL_DEFAULT_HEIGHT = 200

// ============================================================================
// 状态接口定义
// ============================================================================

/**
 * 工作区状态接口
 */
export interface WorkspaceState {
  // -------------------------------------------------------------------------
  // 活动栏状态
  // -------------------------------------------------------------------------
  /** 当前激活的视图 */
  activeView: ActiveView

  // -------------------------------------------------------------------------
  // 侧边栏状态
  // -------------------------------------------------------------------------
  /** 侧边栏是否可见 */
  sidebarVisible: boolean
  /** 侧边栏宽度 (px) */
  sidebarWidth: number

  // -------------------------------------------------------------------------
  // 编辑器状态
  // -------------------------------------------------------------------------
  /** 打开的标签页列表 */
  openTabs: EditorTab[]
  /** 当前激活的标签页 ID */
  activeTabId: string | null

  // -------------------------------------------------------------------------
  // 底部面板状态
  // -------------------------------------------------------------------------
  /** 底部面板是否可见 */
  panelVisible: boolean
  /** 底部面板高度 (px) */
  panelHeight: number
  /** 当前激活的面板标签 */
  activePanelTab: PanelTab

  // -------------------------------------------------------------------------
  // 终端状态
  // -------------------------------------------------------------------------
  /** 终端实例列表 */
  terminals: TerminalInstance[]
  /** 当前激活的终端 ID */
  activeTerminalId: string | null

  // -------------------------------------------------------------------------
  // 搜索状态
  // -------------------------------------------------------------------------
  /** 搜索查询字符串 */
  searchQuery: string
  /** 搜索结果列表 */
  searchResults: SearchResult[]

  // -------------------------------------------------------------------------
  // 快速打开状态
  // -------------------------------------------------------------------------
  /** 快速打开弹窗是否可见 */
  quickOpenVisible: boolean
  /** 最近打开的文件列表（路径） */
  recentFiles: string[]
  /** 工作区文件索引（用于快速搜索） */
  fileIndex: FileIndexEntry[]
  /** 文件索引是否正在加载 */
  fileIndexLoading: boolean

  // -------------------------------------------------------------------------
  // 输出面板状态
  // -------------------------------------------------------------------------
  /** 输出项列表 */
  outputs: OutputItem[]
  /** 输出搜索查询 */
  outputSearchQuery: string
  /** 输出类型过滤 */
  outputTypeFilter: OutputType | 'all'

  // -------------------------------------------------------------------------
  // 代码选择状态
  // -------------------------------------------------------------------------
  /** 当前代码选择信息 */
  codeSelection: CodeSelectionInfo | null
  /** 待发送到聊天的代码选择（用于跨组件通信） */
  pendingChatSelection: CodeSelectionInfo | null
}

/**
 * 工作区 Actions 接口
 */
export interface WorkspaceActions {
  // -------------------------------------------------------------------------
  // 活动栏 Actions
  // -------------------------------------------------------------------------
  /** 设置当前激活的视图 */
  setActiveView: (view: ActiveView) => void

  // -------------------------------------------------------------------------
  // 侧边栏 Actions
  // -------------------------------------------------------------------------
  /** 切换侧边栏显示/隐藏 */
  toggleSidebar: () => void
  /** 设置侧边栏可见性 */
  setSidebarVisible: (visible: boolean) => void
  /**
   * 设置侧边栏宽度
   * @param width 宽度值，会被约束在 [SIDEBAR_MIN_WIDTH, maxWidth] 范围内
   * @param containerWidth 容器宽度，用于计算最大宽度
   */
  setSidebarWidth: (width: number, containerWidth?: number) => void

  // -------------------------------------------------------------------------
  // 编辑器 Actions
  // -------------------------------------------------------------------------
  /**
   * 打开文件
   * 如果文件已打开，则激活该标签页；否则创建新标签页
   * @param path 文件路径
   * @param title 可选的标题，默认使用文件名
   * @param iconUrl 可选的图标 URL
   */
  openFile: (path: string, title?: string, iconUrl?: string) => void
  /** 关闭标签页 */
  closeTab: (tabId: string) => void
  /** 关闭其他标签页 */
  closeOtherTabs: (tabId: string) => void
  /** 关闭所有标签页 */
  closeAllTabs: () => void
  /** 设置当前激活的标签页 */
  setActiveTab: (tabId: string | null) => void
  /** 设置标签页的 dirty 状态 */
  setTabDirty: (tabId: string, dirty: boolean) => void
  /** 重新排序标签页 */
  reorderTabs: (fromIndex: number, toIndex: number) => void

  // -------------------------------------------------------------------------
  // 底部面板 Actions
  // -------------------------------------------------------------------------
  /** 切换底部面板显示/隐藏 */
  togglePanel: () => void
  /** 设置底部面板可见性 */
  setPanelVisible: (visible: boolean) => void
  /**
   * 设置底部面板高度
   * @param height 高度值，会被约束在 [PANEL_MIN_HEIGHT, maxHeight] 范围内
   * @param containerHeight 容器高度，用于计算最大高度
   */
  setPanelHeight: (height: number, containerHeight?: number) => void
  /** 设置当前激活的面板标签 */
  setActivePanelTab: (tab: PanelTab) => void

  // -------------------------------------------------------------------------
  // 终端 Actions
  // -------------------------------------------------------------------------
  /** 创建新终端 */
  createTerminal: (cwd?: string, title?: string) => string
  /** 关闭终端 */
  closeTerminal: (terminalId: string) => void
  /** 设置当前激活的终端 */
  setActiveTerminal: (terminalId: string | null) => void
  /** 更新终端状态 */
  updateTerminalStatus: (terminalId: string, status: TerminalInstance['status']) => void
  /** 重命名终端 */
  renameTerminal: (terminalId: string, title: string) => void

  // -------------------------------------------------------------------------
  // 搜索 Actions
  // -------------------------------------------------------------------------
  /** 设置搜索查询 */
  setSearchQuery: (query: string) => void
  /** 设置搜索结果 */
  setSearchResults: (results: SearchResult[]) => void
  /** 清空搜索 */
  clearSearch: () => void

  // -------------------------------------------------------------------------
  // 快速打开 Actions
  // -------------------------------------------------------------------------
  /** 打开快速打开弹窗 */
  openQuickOpen: () => void
  /** 关闭快速打开弹窗 */
  closeQuickOpen: () => void
  /** 切换快速打开弹窗 */
  toggleQuickOpen: () => void
  /** 添加最近打开的文件 */
  addRecentFile: (path: string) => void
  /** 清空最近文件记录 */
  clearRecentFiles: () => void
  /** 设置文件索引 */
  setFileIndex: (entries: FileIndexEntry[]) => void
  /** 设置文件索引加载状态 */
  setFileIndexLoading: (loading: boolean) => void

  // -------------------------------------------------------------------------
  // 输出面板 Actions
  // -------------------------------------------------------------------------
  /** 添加输出项 */
  addOutput: (item: Omit<OutputItem, 'id' | 'timestamp'>) => string
  /** 更新输出项（用于更新工具执行状态） */
  updateOutput: (id: string, updates: Partial<OutputItem>) => void
  /** 清空输出 */
  clearOutputs: () => void
  /** 设置输出搜索查询 */
  setOutputSearchQuery: (query: string) => void
  /** 设置输出类型过滤 */
  setOutputTypeFilter: (filter: OutputType | 'all') => void

  // -------------------------------------------------------------------------
  // 代码选择 Actions
  // -------------------------------------------------------------------------
  /** 设置代码选择 */
  setCodeSelection: (selection: CodeSelectionInfo | null) => void
  /** 清空代码选择 */
  clearCodeSelection: () => void
  /** 发送代码选择到聊天（设置 pendingChatSelection） */
  sendCodeSelectionToChat: (selection: CodeSelectionInfo) => void
  /** 消费待发送的代码选择（聊天组件调用后清空） */
  consumePendingChatSelection: () => CodeSelectionInfo | null

  // -------------------------------------------------------------------------
  // 工具方法
  // -------------------------------------------------------------------------
  /** 重置为默认状态 */
  reset: () => void
}

/**
 * 完整的工作区 Store 类型
 */
export type WorkspaceStore = WorkspaceState & WorkspaceActions

// ============================================================================
// 默认状态
// ============================================================================

const defaultState: WorkspaceState = {
  // 活动栏
  activeView: 'explorer',

  // 侧边栏
  sidebarVisible: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,

  // 编辑器
  openTabs: [],
  activeTabId: null,

  // 底部面板
  panelVisible: false,
  panelHeight: PANEL_DEFAULT_HEIGHT,
  activePanelTab: 'terminal',

  // 终端
  terminals: [],
  activeTerminalId: null,

  // 搜索
  searchQuery: '',
  searchResults: [],

  // 快速打开
  quickOpenVisible: false,
  recentFiles: [],
  fileIndex: [],
  fileIndexLoading: false,

  // 输出面板
  outputs: [],
  outputSearchQuery: '',
  outputTypeFilter: 'all',

  // 代码选择
  codeSelection: null,
  pendingChatSelection: null,
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * 约束侧边栏宽度在有效范围内
 * @param width 原始宽度
 * @param containerWidth 容器宽度（可选）
 * @returns 约束后的宽度
 */
export function constrainSidebarWidth(width: number, containerWidth?: number): number {
  const minWidth = SIDEBAR_MIN_WIDTH
  const maxWidth = containerWidth
    ? Math.floor(containerWidth * SIDEBAR_MAX_WIDTH_RATIO)
    : Number.MAX_SAFE_INTEGER

  return Math.max(minWidth, Math.min(width, maxWidth))
}

/**
 * 约束底部面板高度在有效范围内
 * @param height 原始高度
 * @param containerHeight 容器高度（可选）
 * @returns 约束后的高度
 */
export function constrainPanelHeight(height: number, containerHeight?: number): number {
  const minHeight = PANEL_MIN_HEIGHT
  const maxHeight = containerHeight
    ? Math.floor(containerHeight * PANEL_MAX_HEIGHT_RATIO)
    : Number.MAX_SAFE_INTEGER

  return Math.max(minHeight, Math.min(height, maxHeight))
}

/**
 * 从文件路径提取文件名
 */
function getFileNameFromPath(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

// ============================================================================
// Store 创建
// ============================================================================

/**
 * 工作区状态 Store
 *
 * 使用 Zustand 管理工作区的所有状态，包括：
 * - 活动栏视图切换
 * - 侧边栏显示/隐藏和宽度调整
 * - 编辑器标签页管理
 * - 底部面板显示/隐藏和高度调整
 * - 终端实例管理
 * - 搜索状态
 * - 快速打开弹窗
 *
 * 状态会自动持久化到 localStorage
 */
export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      // 初始状态
      ...defaultState,

      // -----------------------------------------------------------------------
      // 活动栏 Actions
      // -----------------------------------------------------------------------
      setActiveView: (view) => {
        set({ activeView: view })
      },

      // -----------------------------------------------------------------------
      // 侧边栏 Actions
      // -----------------------------------------------------------------------
      toggleSidebar: () => {
        set((state) => ({ sidebarVisible: !state.sidebarVisible }))
      },

      setSidebarVisible: (visible) => {
        set({ sidebarVisible: visible })
      },

      setSidebarWidth: (width, containerWidth) => {
        const constrainedWidth = constrainSidebarWidth(width, containerWidth)
        set({ sidebarWidth: constrainedWidth })
      },

      // -----------------------------------------------------------------------
      // 编辑器 Actions
      // -----------------------------------------------------------------------
      openFile: (path, title, iconUrl) => {
        const state = get()

        // 添加到最近文件记录
        get().addRecentFile(path)

        // P2: 标签页唯一性 - 检查是否已存在相同路径的标签页
        const existingTab = state.openTabs.find(
          (tab) => tab.kind === 'file' && tab.path === path
        )

        if (existingTab) {
          // 如果已存在，只激活该标签页
          set({ activeTabId: existingTab.id })
          return
        }

        // 创建新标签页
        const newTab: EditorTab = {
          id: generateId(),
          kind: 'file',
          title: title || getFileNameFromPath(path),
          path,
          dirty: false,
          iconUrl,
        }

        set({
          openTabs: [...state.openTabs, newTab],
          activeTabId: newTab.id,
        })
      },

      closeTab: (tabId) => {
        const state = get()
        const tabIndex = state.openTabs.findIndex((tab) => tab.id === tabId)

        if (tabIndex === -1) return

        const newTabs = state.openTabs.filter((tab) => tab.id !== tabId)

        // 如果关闭的是当前激活的标签页，需要选择新的激活标签页
        let newActiveTabId = state.activeTabId
        if (state.activeTabId === tabId) {
          if (newTabs.length === 0) {
            newActiveTabId = null
          } else if (tabIndex >= newTabs.length) {
            // 如果关闭的是最后一个，选择前一个
            newActiveTabId = newTabs[newTabs.length - 1].id
          } else {
            // 否则选择同位置的标签页
            newActiveTabId = newTabs[tabIndex].id
          }
        }

        set({
          openTabs: newTabs,
          activeTabId: newActiveTabId,
        })
      },

      closeOtherTabs: (tabId) => {
        const state = get()
        const tabToKeep = state.openTabs.find((tab) => tab.id === tabId)

        if (!tabToKeep) return

        set({
          openTabs: [tabToKeep],
          activeTabId: tabId,
        })
      },

      closeAllTabs: () => {
        set({
          openTabs: [],
          activeTabId: null,
        })
      },

      setActiveTab: (tabId) => {
        set({ activeTabId: tabId })
      },

      setTabDirty: (tabId, dirty) => {
        set((state) => ({
          openTabs: state.openTabs.map((tab) =>
            tab.id === tabId ? { ...tab, dirty } : tab
          ),
        }))
      },

      reorderTabs: (fromIndex, toIndex) => {
        set((state) => {
          const newTabs = [...state.openTabs]
          const [movedTab] = newTabs.splice(fromIndex, 1)
          newTabs.splice(toIndex, 0, movedTab)
          return { openTabs: newTabs }
        })
      },

      // -----------------------------------------------------------------------
      // 底部面板 Actions
      // -----------------------------------------------------------------------
      togglePanel: () => {
        set((state) => ({ panelVisible: !state.panelVisible }))
      },

      setPanelVisible: (visible) => {
        set({ panelVisible: visible })
      },

      setPanelHeight: (height, containerHeight) => {
        const constrainedHeight = constrainPanelHeight(height, containerHeight)
        set({ panelHeight: constrainedHeight })
      },

      setActivePanelTab: (tab) => {
        set({ activePanelTab: tab })
      },

      // -----------------------------------------------------------------------
      // 终端 Actions
      // -----------------------------------------------------------------------
      createTerminal: (cwd = '~', title) => {
        // 终端 ID 必须是 36 字符的 UUID 格式，因为 TerminalMuxClient 有严格验证
        const id = crypto.randomUUID()
        const terminalTitle = title || `Terminal ${get().terminals.length + 1}`

        const newTerminal: TerminalInstance = {
          id,
          title: terminalTitle,
          cwd,
          status: 'connecting',
        }

        set((state) => ({
          terminals: [...state.terminals, newTerminal],
          activeTerminalId: id,
          // 创建终端时自动显示面板
          panelVisible: true,
          activePanelTab: 'terminal',
        }))

        return id
      },

      closeTerminal: (terminalId) => {
        const state = get()
        const terminalIndex = state.terminals.findIndex((t) => t.id === terminalId)

        if (terminalIndex === -1) return

        const newTerminals = state.terminals.filter((t) => t.id !== terminalId)

        // 如果关闭的是当前激活的终端，需要选择新的激活终端
        let newActiveTerminalId = state.activeTerminalId
        if (state.activeTerminalId === terminalId) {
          if (newTerminals.length === 0) {
            newActiveTerminalId = null
          } else if (terminalIndex >= newTerminals.length) {
            newActiveTerminalId = newTerminals[newTerminals.length - 1].id
          } else {
            newActiveTerminalId = newTerminals[terminalIndex].id
          }
        }

        set({
          terminals: newTerminals,
          activeTerminalId: newActiveTerminalId,
        })
      },

      setActiveTerminal: (terminalId) => {
        set({ activeTerminalId: terminalId })
      },

      updateTerminalStatus: (terminalId, status) => {
        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === terminalId ? { ...t, status } : t
          ),
        }))
      },

      renameTerminal: (terminalId, title) => {
        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === terminalId ? { ...t, title } : t
          ),
        }))
      },

      // -----------------------------------------------------------------------
      // 搜索 Actions
      // -----------------------------------------------------------------------
      setSearchQuery: (query) => {
        set({ searchQuery: query })
      },

      setSearchResults: (results) => {
        set({ searchResults: results })
      },

      clearSearch: () => {
        set({
          searchQuery: '',
          searchResults: [],
        })
      },

      // -----------------------------------------------------------------------
      // 快速打开 Actions
      // -----------------------------------------------------------------------
      openQuickOpen: () => {
        set({ quickOpenVisible: true })
      },

      closeQuickOpen: () => {
        set({ quickOpenVisible: false })
      },

      toggleQuickOpen: () => {
        set((state) => ({ quickOpenVisible: !state.quickOpenVisible }))
      },

      addRecentFile: (path) => {
        set((state) => {
          // 移除已存在的相同路径，然后添加到开头
          const filtered = state.recentFiles.filter((p) => p !== path)
          // 最多保留 20 个最近文件
          const newRecentFiles = [path, ...filtered].slice(0, 20)
          return { recentFiles: newRecentFiles }
        })
      },

      clearRecentFiles: () => {
        set({ recentFiles: [] })
      },

      setFileIndex: (entries) => {
        set({ fileIndex: entries })
      },

      setFileIndexLoading: (loading) => {
        set({ fileIndexLoading: loading })
      },

      // -----------------------------------------------------------------------
      // 输出面板 Actions
      // -----------------------------------------------------------------------
      addOutput: (item) => {
        const id = generateId()
        const newItem: OutputItem = {
          ...item,
          id,
          timestamp: new Date(),
        }
        set((state) => ({
          outputs: [...state.outputs, newItem],
        }))
        return id
      },

      updateOutput: (id, updates) => {
        set((state) => ({
          outputs: state.outputs.map((o) =>
            o.id === id ? { ...o, ...updates } : o
          ),
        }))
      },

      clearOutputs: () => {
        set({ outputs: [] })
      },

      setOutputSearchQuery: (query) => {
        set({ outputSearchQuery: query })
      },

      setOutputTypeFilter: (filter) => {
        set({ outputTypeFilter: filter })
      },

      // -----------------------------------------------------------------------
      // 代码选择 Actions
      // -----------------------------------------------------------------------
      setCodeSelection: (selection) => {
        set({ codeSelection: selection })
      },

      clearCodeSelection: () => {
        set({ codeSelection: null })
      },

      sendCodeSelectionToChat: (selection) => {
        set({ pendingChatSelection: selection })
      },

      consumePendingChatSelection: () => {
        const state = get()
        const selection = state.pendingChatSelection
        if (selection) {
          set({ pendingChatSelection: null })
        }
        return selection
      },

      // -----------------------------------------------------------------------
      // 工具方法
      // -----------------------------------------------------------------------
      reset: () => {
        set(defaultState)
      },
    }),
    {
      name: 'myyucode-workspace-storage',
      storage: createJSONStorage(() => localStorage),
      // P4: 布局状态持久化 - 只持久化布局相关的状态
      partialize: (state) => ({
        activeView: state.activeView,
        sidebarVisible: state.sidebarVisible,
        sidebarWidth: state.sidebarWidth,
        panelVisible: state.panelVisible,
        panelHeight: state.panelHeight,
        activePanelTab: state.activePanelTab,
        recentFiles: state.recentFiles,
        // 不持久化：openTabs, terminals, searchQuery, searchResults, quickOpenVisible, fileIndex
        // 这些是运行时状态，不需要跨会话保持
      }),
    }
  )
)

// ============================================================================
// 选择器 (Selectors)
// ============================================================================

/**
 * 获取当前激活的标签页
 */
export const selectActiveTab = (state: WorkspaceStore): EditorTab | null => {
  if (!state.activeTabId) return null
  return state.openTabs.find((tab) => tab.id === state.activeTabId) || null
}

/**
 * 获取当前激活的终端
 */
export const selectActiveTerminal = (state: WorkspaceStore): TerminalInstance | null => {
  if (!state.activeTerminalId) return null
  return state.terminals.find((t) => t.id === state.activeTerminalId) || null
}

/**
 * 检查是否有未保存的标签页
 */
export const selectHasDirtyTabs = (state: WorkspaceStore): boolean => {
  return state.openTabs.some((tab) => tab.dirty)
}

/**
 * 获取未保存的标签页列表
 */
export const selectDirtyTabs = (state: WorkspaceStore): EditorTab[] => {
  return state.openTabs.filter((tab) => tab.dirty)
}

/**
 * 根据文件路径查找标签页
 */
export const selectTabByPath = (state: WorkspaceStore, path: string): EditorTab | null => {
  return state.openTabs.find((tab) => tab.kind === 'file' && tab.path === path) || null
}
