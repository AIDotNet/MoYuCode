import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { api, formatUtc } from '@/api/client'
import type {
  CodexDailyTokenUsageDto,
  GitStatusResponse,
  ProjectDto,
  ProjectSessionDto,
  SessionTokenUsageDto,
} from '@/api/types'
import { cn } from '@/lib/utils'
import { TokenUsageBar, TokenUsageDailyChart } from '@/components/CodexSessionViz'
import { SessionAwareProjectChat } from '@/components/project-workspace/SessionAwareProjectChat'
import { WorkspaceLayout } from '@/components/workspace/WorkspaceLayout'
import { useWorkspaceStore, type CodeSelectionInfo } from '@/stores/workspaceStore'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/animate-ui/primitives/animate/tooltip'
import {
  ArrowLeft,
  PanelRightOpen,
} from 'lucide-react'
import type { CodeSelection } from '@/lib/chatPromptXml'
import { useInstanceTracking } from '@/hooks/useInstanceTracking'


// Generate a unique instance ID for multi-instance isolation
function generateInstanceId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    // fallback
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`
}

export type ProjectWorkspaceHandle = {
  openFile: (path: string) => void
  openProjectSummary: () => void
  openTerminal: (opts?: { path?: string; focus?: boolean }) => void
  toggleRightPanel: () => void
  isRightPanelOpen: boolean
}

type ProjectWorkspacePageProps = {
  projectId?: string
  currentToolType?: 'Codex' | 'ClaudeCode' | null
  sessionId?: string | null
  rightPanelOpen?: boolean
  onRightPanelOpenChange?: (open: boolean) => void
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function sumSessionTokens(s: ProjectSessionDto): number {
  return (
    (s.tokenUsage?.inputTokens ?? 0) +
    (s.tokenUsage?.cachedInputTokens ?? 0) +
    (s.tokenUsage?.outputTokens ?? 0) +
    (s.tokenUsage?.reasoningOutputTokens ?? 0)
  )
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'

  const abs = Math.abs(value)
  if (abs < 1000) return value.toLocaleString()

  try {
    const fmt = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: 1,
    })
    return fmt.format(value)
  } catch {
    const sign = value < 0 ? '-' : ''
    const stripTrailingZero = (raw: string) =>
      raw.endsWith('.0') ? raw.slice(0, -2) : raw

    if (abs < 1_000_000) {
      const n = abs / 1000
      return `${sign}${stripTrailingZero(n.toFixed(1))}K`
    }

    if (abs < 1_000_000_000) {
      const n = abs / 1_000_000
      return `${sign}${stripTrailingZero(n.toFixed(1))}M`
    }

    const n = abs / 1_000_000_000
    return `${sign}${stripTrailingZero(n.toFixed(1))}B`
  }
}

function formatLocalYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function tryGetLocalDayKey(iso: string | null | undefined): string | null {
  const raw = (iso ?? '').trim()
  if (!raw) return null
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return null
  return formatLocalYmd(new Date(t))
}

function emptyTokenUsage(): SessionTokenUsageDto {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
}

// ProjectSummaryPanel 组件暂时保留，将在后续版本中集成到 WorkspaceLayout
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ProjectSummaryPanel({ project }: { project: ProjectDto }) {
  const workspacePath = project.workspacePath.trim()

  const [sessions, setSessions] = useState<ProjectSessionDto[] | null>(null)
  const [hasGitRepo, setHasGitRepo] = useState<boolean | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const [sessionsData, gitExists] = await Promise.all([
        api.projects.sessions(project.id),
        workspacePath
          ? api.fs.hasGitRepo(workspacePath).catch(() => false)
          : Promise.resolve(false),
      ])

      setSessions(sessionsData)
      setHasGitRepo(gitExists)

      if (gitExists && workspacePath) {
        const status = await api.git.status(workspacePath)
        setGitStatus(status)
      } else {
        setGitStatus(null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [project.id, workspacePath])

  useEffect(() => {
    void load()
  }, [load])

  const sessionsSummary = useMemo(() => {
    const data = sessions ?? []
    const durationMs = data.reduce((acc, s) => acc + (s.durationMs ?? 0), 0)
    const tokenTotal = data.reduce((acc, s) => acc + sumSessionTokens(s), 0)
    const eventTotals = data.reduce(
      (acc, s) => {
        acc.message += s.eventCounts?.message ?? 0
        acc.functionCall += s.eventCounts?.functionCall ?? 0
        acc.agentReasoning += s.eventCounts?.agentReasoning ?? 0
        acc.tokenCount += s.eventCounts?.tokenCount ?? 0
        acc.other += s.eventCounts?.other ?? 0
        return acc
      },
      { message: 0, functionCall: 0, agentReasoning: 0, tokenCount: 0, other: 0 },
    )

    return { count: data.length, durationMs, tokenTotal, eventTotals }
  }, [sessions])


  const projectTokenUsage: SessionTokenUsageDto = useMemo(() => {
    const totals = emptyTokenUsage()
    for (const s of sessions ?? []) {
      totals.inputTokens += s.tokenUsage?.inputTokens ?? 0
      totals.cachedInputTokens += s.tokenUsage?.cachedInputTokens ?? 0
      totals.outputTokens += s.tokenUsage?.outputTokens ?? 0
      totals.reasoningOutputTokens += s.tokenUsage?.reasoningOutputTokens ?? 0
    }
    return totals
  }, [sessions])

  const dailyTokenUsage7d: CodexDailyTokenUsageDto[] = useMemo(() => {
    const data = sessions ?? []
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    const start = new Date(end)
    start.setDate(start.getDate() - 6)

    const dayKeys: string[] = []
    const byDay = new Map<string, SessionTokenUsageDto>()

    for (let i = 0; i < 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      const key = formatLocalYmd(d)
      dayKeys.push(key)
      byDay.set(key, emptyTokenUsage())
    }

    for (const s of data) {
      const key = tryGetLocalDayKey(s.lastEventAtUtc || s.createdAtUtc)
      if (!key) continue
      const bucket = byDay.get(key)
      if (!bucket) continue

      bucket.inputTokens += s.tokenUsage?.inputTokens ?? 0
      bucket.cachedInputTokens += s.tokenUsage?.cachedInputTokens ?? 0
      bucket.outputTokens += s.tokenUsage?.outputTokens ?? 0
      bucket.reasoningOutputTokens += s.tokenUsage?.reasoningOutputTokens ?? 0
    }

    return dayKeys.map((date) => ({
      date,
      tokenUsage: byDay.get(date) ?? emptyTokenUsage(),
    }))
  }, [sessions])

  const tokenTotal7d = useMemo(() => {
    return dailyTokenUsage7d.reduce((acc, d) => {
      const u = d.tokenUsage
      return (
        acc +
        (u?.inputTokens ?? 0) +
        (u?.cachedInputTokens ?? 0) +
        (u?.outputTokens ?? 0) +
        (u?.reasoningOutputTokens ?? 0)
      )
    }, 0)
  }, [dailyTokenUsage7d])

  const gitSummary = useMemo(() => {
    if (!gitStatus) return null
    const staged = gitStatus.entries.filter((e) => e.indexStatus !== ' ').length
    const worktree = gitStatus.entries.filter((e) => e.worktreeStatus !== ' ').length
    const untracked = gitStatus.entries.filter(
      (e) => e.indexStatus === '?' && e.worktreeStatus === '?',
    ).length
    return {
      branch: gitStatus.branch,
      repoRoot: gitStatus.repoRoot,
      total: gitStatus.entries.length,
      staged,
      worktree,
      untracked,
    }
  }, [gitStatus])


  return (
    <div className="h-full min-h-0 overflow-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">项目数据汇总</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {project.name} · {project.toolType === 'Codex' ? 'Codex' : 'Claude Code'}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          刷新
          {loading ? <Spinner /> : null}
        </Button>
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">项目信息</div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="break-all">路径：{project.workspacePath}</div>
            <div>Provider：{project.providerName || project.providerId || '—'}</div>
            <div>Model：{project.model ?? '—'}</div>
            <div>创建：{formatUtc(project.createdAtUtc)}</div>
            <div>更新：{formatUtc(project.updatedAtUtc)}</div>
            <div>最近启动：{formatUtc(project.lastStartedAtUtc) || '—'}</div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">会话统计</div>
          {sessions ? (
            <div className="mt-3 space-y-1 text-sm">
              <div>会话数：{sessionsSummary.count.toLocaleString()}</div>
              <div>总耗时：{formatDurationMs(sessionsSummary.durationMs)}</div>
              <div title={sessionsSummary.tokenTotal.toLocaleString()}>
                总 Tokens：{formatCompactNumber(sessionsSummary.tokenTotal)}
              </div>
              <div className="text-xs text-muted-foreground">
                消息 {sessionsSummary.eventTotals.message.toLocaleString()} · 工具{' '}
                {sessionsSummary.eventTotals.functionCall.toLocaleString()} · 思考{' '}
                {sessionsSummary.eventTotals.agentReasoning.toLocaleString()}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-muted-foreground">
              {loading ? '统计中…' : '暂无数据'}
            </div>
          )}
        </div>
      </div>


      <div className="mt-4 rounded-lg border bg-card p-4">
        <div className="text-sm font-medium">Token 汇总</div>
        <div className="mt-1 text-xs text-muted-foreground">
          汇总该项目所有会话的输入 / 缓存 / 输出 / 思考 Token，并展示最近 7 天每天消耗。
        </div>

        {sessions ? (
          <div className="mt-4 space-y-4">
            <TokenUsageBar usage={projectTokenUsage} />

            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div className="rounded-md border bg-background/40 p-2">
                <div className="text-xs text-muted-foreground">输入</div>
                <div className="mt-1 font-medium tabular-nums" title={projectTokenUsage.inputTokens.toLocaleString()}>
                  {formatCompactNumber(projectTokenUsage.inputTokens)}
                </div>
              </div>
              <div className="rounded-md border bg-background/40 p-2">
                <div className="text-xs text-muted-foreground">缓存</div>
                <div className="mt-1 font-medium tabular-nums" title={projectTokenUsage.cachedInputTokens.toLocaleString()}>
                  {formatCompactNumber(projectTokenUsage.cachedInputTokens)}
                </div>
              </div>
              <div className="rounded-md border bg-background/40 p-2">
                <div className="text-xs text-muted-foreground">输出</div>
                <div className="mt-1 font-medium tabular-nums" title={projectTokenUsage.outputTokens.toLocaleString()}>
                  {formatCompactNumber(projectTokenUsage.outputTokens)}
                </div>
              </div>
              <div className="rounded-md border bg-background/40 p-2">
                <div className="text-xs text-muted-foreground">思考</div>
                <div className="mt-1 font-medium tabular-nums" title={projectTokenUsage.reasoningOutputTokens.toLocaleString()}>
                  {formatCompactNumber(projectTokenUsage.reasoningOutputTokens)}
                </div>
              </div>
            </div>

            <div className="rounded-md border bg-background/40 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-xs text-muted-foreground">最近 7 天</div>
                <div className="text-xs font-medium tabular-nums" title={tokenTotal7d.toLocaleString()}>
                  总计：{formatCompactNumber(tokenTotal7d)}
                </div>
              </div>
              <div className="mt-3">
                <TokenUsageDailyChart days={dailyTokenUsage7d} />
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 text-sm text-muted-foreground">
            {loading ? '统计中…' : '暂无数据'}
          </div>
        )}
      </div>


      <div className="mt-4 rounded-lg border bg-card p-4">
        <div className="text-sm font-medium">Git 状态</div>
        {hasGitRepo === false ? (
          <div className="mt-2 text-sm text-muted-foreground">未检测到 Git 仓库</div>
        ) : null}
        {hasGitRepo && gitSummary ? (
          <div className="mt-3 space-y-1 text-sm">
            <div>分支：{gitSummary.branch ?? '—'}</div>
            <div className="break-all">根目录：{gitSummary.repoRoot}</div>
            <div>
              变更：{gitSummary.total.toLocaleString()}（暂存{' '}
              {gitSummary.staged.toLocaleString()} · 工作区{' '}
              {gitSummary.worktree.toLocaleString()} · 未跟踪{' '}
              {gitSummary.untracked.toLocaleString()}）
            </div>
          </div>
        ) : hasGitRepo ? (
          <div className="mt-2 text-sm text-muted-foreground">
            {loading ? '加载中…' : '暂无数据'}
          </div>
        ) : null}
      </div>
    </div>
  )
}


export const ProjectWorkspacePage = forwardRef<ProjectWorkspaceHandle, ProjectWorkspacePageProps>(
  function ProjectWorkspacePage({
    projectId,
    currentToolType,
    sessionId,
    rightPanelOpen: externalRightPanelOpen,
    onRightPanelOpenChange
  }: ProjectWorkspacePageProps, ref) {
  const { id: routeId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // Generate unique instance ID for multi-instance isolation
  const instanceIdRef = useRef<string>(generateInstanceId())
  const instanceId = instanceIdRef.current

  // Support multiple ways to get project ID
  const id =
    projectId ??
    routeId ??
    searchParams.get('projects') ??
    searchParams.get('project') ??
    undefined

  // Track instance count for multi-instance indicator
  const { projectInstanceCount, hasMultipleProjectInstances } = useInstanceTracking(
    instanceId,
    id
  )

  // Support session ID from props or query params
  const sessionIdFromQuery = searchParams.get('session')
  const effectiveSessionId = sessionId ?? sessionIdFromQuery ?? null

  // Function to update session ID in URL (for standalone mode)
  const _updateSessionInUrl = useCallback((newSessionId: string | null) => {
    if (projectId) return
    const newParams = new URLSearchParams(searchParams)
    if (newSessionId) {
      newParams.set('session', newSessionId)
    } else {
      newParams.delete('session')
    }
    setSearchParams(newParams, { replace: true })
  }, [projectId, searchParams, setSearchParams])
  void _updateSessionInUrl

  const [project, setProject] = useState<ProjectDto | null>(null)
  const [, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projectNotFound, setProjectNotFound] = useState(false)

  // 左右面板独立控制状态
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [internalRightPanelOpen, setInternalRightPanelOpen] = useState(false)

  // 使用外部状态或内部状态
  const rightPanelOpen = externalRightPanelOpen ?? internalRightPanelOpen
  const handleRightPanelOpenChange = useCallback((open: boolean) => {
    if (onRightPanelOpenChange) {
      onRightPanelOpenChange(open)
    } else {
      setInternalRightPanelOpen(open)
    }
  }, [onRightPanelOpenChange])


  // 左右面板宽度相关状态
  const [leftPanelWidth, setLeftPanelWidth] = useState(0.5)
  const [resizingPanels, setResizingPanels] = useState(false)
  const panelsResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const workspaceContainerRef = useRef<HTMLDivElement | null>(null)

  // 代码选择状态（用于聊天集成）
  const [codeSelection, setCodeSelection] = useState<CodeSelection | null>(null)

  // 详情面板状态（用于工具输出）
  const [detailsPortalTarget] = useState<HTMLDivElement | null>(null)
  const detailsOpen = false // 暂时禁用，后续可以通过 WorkspaceLayout 的输出面板实现

  // 从 workspaceStore 获取 openFile 方法
  const openFileInWorkspace = useWorkspaceStore((state) => state.openFile)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const setPanelVisible = useWorkspaceStore((state) => state.setPanelVisible)
  const setActivePanelTab = useWorkspaceStore((state) => state.setActivePanelTab)

  const load = useCallback(async () => {
    if (!id) {
      setError('未提供项目 ID')
      setProjectNotFound(true)
      return
    }
    
    setLoading(true)
    setError(null)
    setProjectNotFound(false)
    
    try {
      const data = await api.projects.get(id)
      setProject(data)
      setProjectNotFound(false)
    } catch (e) {
      const errorMessage = (e as Error).message
      setError(errorMessage)
      
      if (errorMessage.includes('404') || errorMessage.includes('not found') || errorMessage.includes('Not Found')) {
        setProjectNotFound(true)
        console.error(`Project not found: ${id}`, e)
      } else {
        console.error(`Failed to load project: ${id}`, e)
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])


  // Handle invalid/missing project IDs - redirect to appropriate list page
  useEffect(() => {
    if (projectNotFound && !projectId) {
      const lastVisitedMode = localStorage.getItem('lastVisitedMode') || 'code'
      const redirectPath = lastVisitedMode === 'claude' ? '/claude' : '/code'
      
      console.warn(`Project not found (ID: ${id}), redirecting to ${redirectPath}`)
      sessionStorage.setItem('projectError', `项目未找到 (ID: ${id})`)
      navigate(redirectPath, { replace: true })
    }
  }, [projectNotFound, projectId, id, navigate])

  // Page title management for multi-instance support
  useEffect(() => {
    const originalTitle = document.title

    if (project?.name) {
      document.title = `${project.name} - MoYuCode`
    } else if (error || projectNotFound) {
      document.title = 'MoYuCode'
    }

    return () => {
      document.title = originalTitle
    }
  }, [project?.name, error, projectNotFound])

  const workspacePath = (project?.workspacePath ?? '').trim()

  // Resource cleanup on component unmount
  useEffect(() => {
    if (import.meta.env.DEV) {
      console.debug(`[ProjectWorkspace] Instance ${instanceId} mounted for project ${id}`)
    }

    return () => {
      if (import.meta.env.DEV) {
        console.debug(`[ProjectWorkspace] Instance ${instanceId} unmounting, cleaning up resources`)
      }
    }
  }, [instanceId, id])

  // 确保右侧面板打开
  const ensureRightPanelOpen = useCallback(() => {
    if (!rightPanelOpen) {
      handleRightPanelOpenChange(true)
    }
  }, [rightPanelOpen, handleRightPanelOpenChange])


  // 打开文件（通过新的 WorkspaceLayout）
  const openFile = useCallback(
    (path: string) => {
      const normalized = path.trim()
      if (!normalized) return
      ensureRightPanelOpen()
      openFileInWorkspace(normalized)
    },
    [ensureRightPanelOpen, openFileInWorkspace],
  )

  // 打开项目汇总（使用 ProjectSummaryPanel）
  const openProjectSummary = useCallback(() => {
    ensureRightPanelOpen()
    // TODO: 实现项目汇总面板，使用 ProjectSummaryPanel 组件
    // 目前 WorkspaceLayout 不支持自定义面板，需要后续扩展
  }, [ensureRightPanelOpen])

  // 打开终端
  const openTerminal = useCallback(
    (opts?: { path?: string; focus?: boolean }) => {
      const cwd = (opts?.path ?? workspacePath).trim()
      if (!cwd) return
      ensureRightPanelOpen()
      createTerminal(cwd)
      setPanelVisible(true)
      setActivePanelTab('terminal')
    },
    [createTerminal, ensureRightPanelOpen, setActivePanelTab, setPanelVisible, workspacePath],
  )

  useImperativeHandle(
    ref,
    () => ({
      openFile,
      openProjectSummary,
      openTerminal,
      toggleRightPanel: () => handleRightPanelOpenChange(!rightPanelOpen),
      isRightPanelOpen: rightPanelOpen,
    }),
    [openFile, openProjectSummary, openTerminal, rightPanelOpen, handleRightPanelOpenChange],
  )

  // 处理代码选择发送到聊天
  const handleCodeSelectionToChat = useCallback((selection: CodeSelectionInfo) => {
    setCodeSelection({
      filePath: selection.filePath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      text: selection.text,
    })
  }, [])


  // 左右面板拖拽调整宽度
  const startPanelsResize = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const container = workspaceContainerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const currentLeftWidth = rect.width * leftPanelWidth
    panelsResizeStateRef.current = { startX: e.clientX, startWidth: currentLeftWidth }
    setResizingPanels(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [leftPanelWidth])

  const movePanelsResize = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!resizingPanels) return
    const state = panelsResizeStateRef.current
    const container = workspaceContainerRef.current
    if (!state || !container) return

    const rect = container.getBoundingClientRect()
    const delta = e.clientX - state.startX
    const newLeftWidth = state.startWidth + delta
    const minLeftWidth = 300
    const minRightWidth = 360

    let newPercentage = newLeftWidth / rect.width
    const maxPercentage = 1 - (minRightWidth / rect.width)
    const minPercentage = minLeftWidth / rect.width
    newPercentage = Math.max(minPercentage, Math.min(maxPercentage, newPercentage))

    setLeftPanelWidth(newPercentage)
  }, [resizingPanels])

  const stopPanelsResize = useCallback(() => {
    panelsResizeStateRef.current = null
    setResizingPanels(false)
  }, [])

  // Determine if we're in standalone mode
  const isStandaloneMode = !projectId && routeId

  // Determine the correct list page based on project.toolType
  const getListPagePath = useCallback(() => {
    if (project?.toolType === 'ClaudeCode') {
      return '/claude'
    }
    return '/code'
  }, [project?.toolType])

  const handleBackToList = useCallback(() => {
    const listPath = getListPagePath()
    localStorage.setItem('lastVisitedMode', project?.toolType === 'ClaudeCode' ? 'claude' : 'code')
    navigate(listPath)
  }, [getListPagePath, navigate, project?.toolType])


  return (
    <div className="h-full w-full overflow-hidden flex flex-col bg-background font-sans selection:bg-primary/10">
      {/* ChatGPT-style Global Header */}
      {isStandaloneMode && project && (
        <header className="shrink-0 h-14 flex items-center justify-between px-4 z-30 bg-background/80 backdrop-blur-md">
          <div className="flex items-center gap-3">
            {/* Back to Home/List */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={handleBackToList}
              title="返回项目列表"
            >
              <ArrowLeft className="size-5" />
            </Button>

            {/* Selector-like Title */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-muted/50 transition-all cursor-default group">
              <span className="text-base font-semibold text-foreground/90 tracking-tight">{project.name}</span>
              <div className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-widest",
                project.toolType === 'ClaudeCode' 
                  ? "bg-orange-500/10 text-orange-600 dark:text-orange-400" 
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              )}>
                {project.toolType === 'ClaudeCode' ? 'Claude' : 'Codex'}
              </div>
              
              {hasMultipleProjectInstances && (
                <div className="size-5 flex items-center justify-center rounded-full bg-blue-500/10 text-blue-600 text-[10px] font-black">
                  {projectInstanceCount}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Workspace Toggle (Canvas) */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-9 px-3 gap-2 rounded-xl transition-all",
                      rightPanelOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => handleRightPanelOpenChange(!rightPanelOpen)}
                  >
                    <PanelRightOpen className={cn(
                      "size-4 transition-transform duration-500",
                      !rightPanelOpen && "rotate-180"
                    )} />
                    <span className="text-xs font-semibold">工作区</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  {rightPanelOpen ? '收起工作区' : '打开工作区'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </header>
      )}


      {error && !projectNotFound ? (
        <div className="shrink-0 p-4">
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 flex items-center justify-between gap-4">
            <div className="text-sm text-destructive font-medium">{error}</div>
            <Button variant="outline" size="sm" className="rounded-lg" onClick={() => void load()}>重试</Button>
          </div>
        </div>
      ) : null}
      
      {!id && !projectId ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm font-medium">
          未选择项目
        </div>
      ) : null}
      
      {id && projectNotFound && projectId ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center p-8">
          <div className="text-muted-foreground font-medium">项目未找到 (ID: {id})</div>
          <Button variant="outline" className="rounded-xl px-6" onClick={() => void load()}>重试</Button>
        </div>
      ) : null}
      
      {/* Main Workspace Area */}
      <div
        ref={workspaceContainerRef}
        className="flex-1 min-h-0 flex relative overflow-hidden"
      >
        {/* Left Side: Chat Interface */}
        {leftPanelOpen && project && (
          <>
            <section
              className={cn(
                'h-full flex flex-col transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]',
                rightPanelOpen ? 'shrink-0' : 'flex-1',
              )}
              style={rightPanelOpen ? { width: `${leftPanelWidth * 100}%` } : undefined}
            >
              <div className="h-full relative overflow-hidden">
                <SessionAwareProjectChat
                  key={effectiveSessionId ?? 'new'}
                  project={project}
                  detailsOpen={detailsOpen}
                  detailsPortalTarget={detailsPortalTarget}
                  activeFilePath={null}
                  codeSelection={codeSelection}
                  onClearCodeSelection={() => setCodeSelection(null)}
                  currentToolType={currentToolType}
                  showSessionPanel={true}
                />
              </div>
            </section>

            {/* Clean Resize Handle */}
            {rightPanelOpen && (
              <div
                role="separator"
                className={cn(
                  'w-px h-full z-40 cursor-col-resize hover:bg-primary/30 transition-colors',
                  resizingPanels ? 'bg-primary/50' : 'bg-border/30'
                )}
                onPointerDown={startPanelsResize}
                onPointerMove={movePanelsResize}
                onPointerUp={stopPanelsResize}
                onPointerCancel={stopPanelsResize}
              />
            )}
          </>
        )}


        {/* Right Side: New WorkspaceLayout */}
        <aside
          className={cn(
            'h-full flex flex-col bg-muted/5 transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]',
            rightPanelOpen && project
              ? 'flex-1 opacity-100'
              : 'w-0 opacity-0 pointer-events-none translate-x-8',
          )}
        >
          {rightPanelOpen && project && (
            <WorkspaceLayout
              workspacePath={workspacePath}
              onCodeSelectionToChat={handleCodeSelectionToChat}
              className="h-full"
            />
          )}
        </aside>
      </div>

      {!leftPanelOpen && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="fixed left-6 top-6 z-50 rounded-full shadow-xl animate-in fade-in zoom-in duration-300"
          title="显示聊天"
          onClick={() => setLeftPanelOpen(true)}
        >
          <PanelRightOpen className="size-5" />
        </Button>
      )}
    </div>
  )
},
)
