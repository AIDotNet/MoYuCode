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
import { useParams, useSearchParams } from 'react-router-dom'
import { api, formatUtc } from '@/api/client'
import type {
  CodexDailyTokenUsageDto,
  GitStatusResponse,
  ProjectDto,
  ProjectSessionDto,
  SessionTokenUsageDto,
} from '@/api/types'
import { cn } from '@/lib/utils'
import { getVscodeFileIconUrl } from '@/lib/vscodeFileIcons'
import { DiffViewer, type DiffViewMode } from '@/components/DiffViewer'
import { MonacoCode, type MonacoCodeSelection } from '@/components/MonacoCode'
import { TokenUsageBar, TokenUsageDailyChart } from '@/components/CodexSessionViz'
import { TabStrip, type TabStripItemBase } from '@/components/TabStrip'
import { ProjectFileManager } from '@/components/project-workspace/ProjectFileManager'
import { ProjectChat } from '@/components/project-workspace/ProjectChat'
import { TerminalSession, type TerminalSessionHandle } from '@/components/terminal-kit'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  FileText,
  Folder,
  PanelRightClose,
  PanelRightOpen,
  Terminal,
} from 'lucide-react'
import type { CodeSelection } from '@/lib/chatPromptXml'

type WorkspacePanelId = 'project-summary'

type WorkspaceView =
  | { kind: 'empty' }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; file: string; staged: boolean }
  | { kind: 'terminal'; id: string }
  | { kind: 'output' }
  | { kind: 'panel'; panelId: WorkspacePanelId }

type WorkspaceTab =
  | { kind: 'file'; path: string }
  | { kind: 'diff'; file: string; staged: boolean }
  | { kind: 'terminal'; id: string; cwd: string }
  | { kind: 'panel'; panelId: WorkspacePanelId }

type FilePreview = {
  loading: boolean
  error: string | null
  content: string
  truncated: boolean
  isBinary: boolean
  draft: string
  dirty: boolean
  saving: boolean
  saveError: string | null
}

type DiffPreview = {
  loading: boolean
  error: string | null
  diff: string
  truncated: boolean
}

function getBaseName(fullPath: string): string {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return normalized
  const base = normalized.slice(lastSeparator + 1)
  return base || normalized
}

function isConfigToml(path: string): boolean {
  return getBaseName(path).toLowerCase() === 'config.toml'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getTabKey(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case 'file':
      return `file:${tab.path}`
    case 'diff':
      return `diff:${tab.staged ? 'staged' : 'worktree'}:${tab.file}`
    case 'terminal':
      return `terminal:${tab.id}`
    case 'panel':
      return `panel:${tab.panelId}`
  }
}

function tryGetViewKey(view: WorkspaceView): string | null {
  switch (view.kind) {
    case 'file':
      return `file:${view.path}`
    case 'diff':
      return `diff:${view.staged ? 'staged' : 'worktree'}:${view.file}`
    case 'terminal':
      return `terminal:${view.id}`
    case 'panel':
      return `panel:${view.panelId}`
    case 'empty':
    case 'output':
      return null
  }
}

export type ProjectWorkspaceHandle = {
  openFile: (path: string) => void
  openProjectSummary: () => void
  openTerminal: (opts?: { path?: string; focus?: boolean }) => void
}

type ProjectWorkspacePageProps = {
  projectId?: string
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

    return {
      count: data.length,
      durationMs,
      tokenTotal,
      eventTotals,
    }
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
            <div>
              Provider：{project.providerName || project.providerId || '—'}
            </div>
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
  function ProjectWorkspacePage({ projectId }: ProjectWorkspacePageProps, ref) {
  const { id: routeId } = useParams()
  const [searchParams] = useSearchParams()
  const id =
    projectId ??
    routeId ??
    searchParams.get('projects') ??
    searchParams.get('project') ??
    undefined

  const [project, setProject] = useState<ProjectDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [toolsPanelOpen, setToolsPanelOpen] = useState(true)
  const [fileManagerOpen, setFileManagerOpen] = useState(true)
  const [fileManagerWidthPx, setFileManagerWidthPx] = useState(320)
  const fileManagerWidthInitializedRef = useRef(false)

  const workspaceBodyRef = useRef<HTMLDivElement | null>(null)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [resizing, setResizing] = useState(false)

  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeView, setActiveView] = useState<WorkspaceView>({ kind: 'empty' })
  const [codeSelection, setCodeSelection] = useState<CodeSelection | null>(null)
  const [filePreviewByPath, setFilePreviewByPath] = useState<Record<string, FilePreview>>({})
  const [diffPreviewByFile, setDiffPreviewByFile] = useState<Record<string, DiffPreview>>({})
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>('split')
  const previewInFlightRef = useRef<Set<string>>(new Set())
  const diffInFlightRef = useRef<Set<string>>(new Set())

  const [detailsPortalTarget, setDetailsPortalTarget] = useState<HTMLDivElement | null>(null)
  const detailsOpen = activeView.kind === 'output'

  const terminalSessionsRef = useRef<Record<string, TerminalSessionHandle | null>>({})
  const [terminalStatusById, setTerminalStatusById] = useState<
    Record<string, 'connecting' | 'connected' | 'closed' | 'error'>
  >({})
  const [terminalErrorById, setTerminalErrorById] = useState<Record<string, string | null>>({})

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.projects.get(id)
      setProject(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const workspacePath = (project?.workspacePath ?? '').trim()

  useEffect(() => {
    setTabs([])
    setActiveView({ kind: 'empty' })
    setCodeSelection(null)
    setFilePreviewByPath({})
    setDiffPreviewByFile({})
    terminalSessionsRef.current = {}
    setTerminalStatusById({})
    setTerminalErrorById({})
  }, [workspacePath])

  useEffect(() => {
    if (activeView.kind !== 'file') {
      setCodeSelection(null)
      return
    }

    setCodeSelection((prev) => (prev?.filePath === activeView.path ? prev : null))
  }, [activeView])

  useEffect(() => {
    if (!toolsPanelOpen) return
    if (!fileManagerOpen) return
    if (fileManagerWidthInitializedRef.current) return
    const container = workspaceBodyRef.current
    if (!container) return
    const width = container.clientWidth
    if (!width) return

    const min = 240
    const max = Math.max(min, Math.floor(width * 0.6))
    setFileManagerWidthPx(clamp(Math.round(width / 3), min, max))
    fileManagerWidthInitializedRef.current = true
  }, [fileManagerOpen, toolsPanelOpen])

  const fetchPreview = useCallback(async (path: string) => {
    if (previewInFlightRef.current.has(path)) return
    previewInFlightRef.current.add(path)

    setFilePreviewByPath((prev) => {
      const existing = prev[path]
      const content = existing?.content ?? ''
      return {
        ...prev,
        [path]: {
          loading: true,
          error: null,
          content,
          truncated: existing?.truncated ?? false,
          isBinary: existing?.isBinary ?? false,
          draft: existing?.draft ?? content,
          dirty: existing?.dirty ?? false,
          saving: existing?.saving ?? false,
          saveError: existing?.saveError ?? null,
        },
      }
    })

    try {
      const data = await api.fs.readFile(path)
      setFilePreviewByPath((prev) => ({
        ...prev,
        [path]: {
          loading: false,
          error: null,
          content: data.content,
          truncated: data.truncated,
          isBinary: data.isBinary,
          draft: data.content,
          dirty: false,
          saving: false,
          saveError: null,
        },
      }))
    } catch (e) {
      setFilePreviewByPath((prev) => {
        const existing = prev[path]
        const content = existing?.content ?? ''
        return {
          ...prev,
          [path]: {
            loading: false,
            error: (e as Error).message,
            content,
            truncated: existing?.truncated ?? false,
            isBinary: existing?.isBinary ?? false,
            draft: existing?.draft ?? content,
            dirty: existing?.dirty ?? false,
            saving: existing?.saving ?? false,
            saveError: existing?.saveError ?? null,
          },
        }
      })
    } finally {
      previewInFlightRef.current.delete(path)
    }
  }, [])

  const fetchDiff = useCallback(
    async (file: string, staged: boolean) => {
      const path = workspacePath.trim()
      if (!path) return

      const key = getTabKey({ kind: 'diff', file, staged })

      if (diffInFlightRef.current.has(key)) return
      diffInFlightRef.current.add(key)

      setDiffPreviewByFile((prev) => ({
        ...prev,
        [key]: {
          loading: true,
          error: null,
          diff: prev[key]?.diff ?? '',
          truncated: prev[key]?.truncated ?? false,
        },
      }))

      try {
        const data = await api.git.diff(path, file, { staged })
        setDiffPreviewByFile((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            error: null,
            diff: data.diff,
            truncated: data.truncated,
          },
        }))
      } catch (e) {
        setDiffPreviewByFile((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            error: (e as Error).message,
            diff: prev[key]?.diff ?? '',
            truncated: prev[key]?.truncated ?? false,
          },
        }))
      } finally {
        diffInFlightRef.current.delete(key)
      }
    },
    [workspacePath],
  )

  const openFile = useCallback(
    (path: string) => {
      const normalized = path.trim()
      if (!normalized) return
      setToolsPanelOpen(true)

      setTabs((prev) => {
        const exists = prev.some((t) => t.kind === 'file' && t.path === normalized)
        if (exists) return prev
        return [...prev, { kind: 'file', path: normalized }]
      })

      setActiveView({ kind: 'file', path: normalized })

      const existing = filePreviewByPath[normalized]
      if (!existing) {
        void fetchPreview(normalized)
      }
    },
    [fetchPreview, filePreviewByPath],
  )

  const openDiff = useCallback(
    (file: string, opts?: { staged?: boolean }) => {
      const normalized = file.trim()
      if (!normalized) return
      setToolsPanelOpen(true)

      const staged = Boolean(opts?.staged)
      const tab: WorkspaceTab = { kind: 'diff', file: normalized, staged }
      const key = getTabKey(tab)

      setTabs((prev) => {
        const exists = prev.some((t) => t.kind === 'diff' && t.file === normalized && t.staged === staged)
        if (exists) return prev
        return [...prev, tab]
      })

      setActiveView({ kind: 'diff', file: normalized, staged })

      const existing = diffPreviewByFile[key]
      if (!existing) {
        void fetchDiff(normalized, staged)
      }
    },
    [diffPreviewByFile, fetchDiff],
  )

  const openProjectSummary = useCallback(() => {
    setToolsPanelOpen(true)
    setTabs((prev) => {
      const exists = prev.some((t) => t.kind === 'panel' && t.panelId === 'project-summary')
      if (exists) return prev
      return [...prev, { kind: 'panel', panelId: 'project-summary' }]
    })
    setActiveView({ kind: 'panel', panelId: 'project-summary' })
  }, [])

  const updateFileDraft = useCallback((path: string, draft: string) => {
    setFilePreviewByPath((prev) => {
      const existing = prev[path]
      if (!existing) return prev
      if (existing.isBinary || existing.truncated) return prev

      const nextDirty = draft !== existing.content
      return {
        ...prev,
        [path]: {
          ...existing,
          draft,
          dirty: nextDirty,
          saveError: null,
        },
      }
    })
  }, [])

  const revertFileDraft = useCallback((path: string) => {
    setFilePreviewByPath((prev) => {
      const existing = prev[path]
      if (!existing) return prev
      return {
        ...prev,
        [path]: {
          ...existing,
          draft: existing.content,
          dirty: false,
          saveError: null,
        },
      }
    })
  }, [])

  const saveFileDraft = useCallback(
    async (path: string) => {
      const preview = filePreviewByPath[path]
      if (!preview) return
      if (!isConfigToml(path)) return
      if (preview.saving) return
      if (preview.isBinary || preview.truncated) return
      if (!preview.dirty) return

      const content = preview.draft ?? ''

      setFilePreviewByPath((prev) => {
        const existing = prev[path]
        if (!existing) return prev
        return {
          ...prev,
          [path]: {
            ...existing,
            saving: true,
            saveError: null,
          },
        }
      })

      try {
        await api.fs.writeFile({ path, content })
        setFilePreviewByPath((prev) => {
          const existing = prev[path]
          if (!existing) return prev
          return {
            ...prev,
            [path]: {
              ...existing,
              content,
              draft: content,
              dirty: false,
              saving: false,
              saveError: null,
            },
          }
        })
      } catch (e) {
        setFilePreviewByPath((prev) => {
          const existing = prev[path]
          if (!existing) return prev
          return {
            ...prev,
            [path]: {
              ...existing,
              saving: false,
              saveError: (e as Error).message,
            },
          }
        })
      }
    },
    [filePreviewByPath],
  )

  const openExternalTerminal = useCallback(async (path: string) => {
    const normalized = path.trim()
    if (!normalized) return
    try {
      await api.fs.openTerminal(normalized)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const createTerminalId = useCallback((): string => {
    const cryptoObj = globalThis.crypto as Crypto | undefined
    try {
      if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
    } catch {
      // ignore
    }

    // Fallback: RFC4122 v4 UUID from random bytes, so the mux header stays fixed-length.
    const bytes = new Uint8Array(16)
    try {
      cryptoObj?.getRandomValues?.(bytes)
    } catch {
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256)
      }
    }

    // Set version (4) and variant (RFC4122).
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }, [])

  const openTerminal = useCallback(
    (opts?: { path?: string; focus?: boolean }) => {
      const cwd = (opts?.path ?? workspacePath).trim()
      if (!cwd) return

      const id = createTerminalId()
      const tab: WorkspaceTab = { kind: 'terminal', id, cwd }

      setToolsPanelOpen(true)
      setTabs((prev) => [...prev, tab])
      setActiveView({ kind: 'terminal', id })

      setTerminalStatusById((prev) => ({ ...prev, [id]: 'connecting' }))
      setTerminalErrorById((prev) => ({ ...prev, [id]: null }))

      if (opts?.focus) {
        window.setTimeout(() => terminalSessionsRef.current[id]?.focus(), 0)
      }
    },
    [createTerminalId, workspacePath],
  )

  useImperativeHandle(
    ref,
    () => ({
      openFile,
      openProjectSummary,
      openTerminal,
    }),
    [openFile, openProjectSummary, openTerminal],
  )

  const closeTab = useCallback(
    (tab: WorkspaceTab) => {
      const key = getTabKey(tab)

      setTabs((prev) => {
        const next = prev.filter((t) => getTabKey(t) !== key)

        setActiveView((view) => {
          const isActive =
            (tab.kind === 'file' && view.kind === 'file' && view.path === tab.path) ||
            (tab.kind === 'diff' &&
              view.kind === 'diff' &&
              view.file === tab.file &&
              view.staged === tab.staged) ||
            (tab.kind === 'terminal' && view.kind === 'terminal' && view.id === tab.id) ||
            (tab.kind === 'panel' && view.kind === 'panel' && view.panelId === tab.panelId)
          if (!isActive) return view

          const last = next[next.length - 1]
          if (!last) return { kind: 'empty' }
          switch (last.kind) {
            case 'file':
              return { kind: 'file', path: last.path }
            case 'diff':
              return { kind: 'diff', file: last.file, staged: last.staged }
            case 'terminal':
              return { kind: 'terminal', id: last.id }
            case 'panel':
              return { kind: 'panel', panelId: last.panelId }
          }
        })

        return next
      })

      if (tab.kind === 'file') {
        setFilePreviewByPath((prev) => {
          const next = { ...prev }
          delete next[tab.path]
          return next
        })
      } else if (tab.kind === 'diff') {
        setDiffPreviewByFile((prev) => {
          const key = getTabKey(tab)
          const next = { ...prev }
          delete next[key]
          return next
        })
      } else if (tab.kind === 'terminal') {
        terminalSessionsRef.current[tab.id] = null
        setTerminalStatusById((prev) => {
          const next = { ...prev }
          delete next[tab.id]
          return next
        })
        setTerminalErrorById((prev) => {
          const next = { ...prev }
          delete next[tab.id]
          return next
        })
      }
    },
    [],
  )

  const startResize = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!fileManagerOpen) return
      const container = workspaceBodyRef.current
      if (!container) return

      resizeStateRef.current = { startX: e.clientX, startWidth: fileManagerWidthPx }
      setResizing(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [fileManagerOpen, fileManagerWidthPx],
  )

  const moveResize = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!resizing) return
      const state = resizeStateRef.current
      const container = workspaceBodyRef.current
      if (!state || !container) return

      const width = container.clientWidth
      if (!width) return

      const delta = e.clientX - state.startX
      const min = 240
      const minRight = 360
      const max = Math.max(min, width - minRight)
      const next = clamp(state.startWidth + delta, min, max)
      setFileManagerWidthPx(next)
    },
    [resizing],
  )

  const stopResize = useCallback(() => {
    resizeStateRef.current = null
    setResizing(false)
  }, [])

  type WorkspaceMainTab = WorkspaceTab & TabStripItemBase

  const mainTabs = useMemo<WorkspaceMainTab[]>(() => {
    return tabs.map((tab) => {
      if (tab.kind === 'file') {
        const dirty = Boolean(filePreviewByPath[tab.path]?.dirty)
        const base = getBaseName(tab.path)
        return {
          ...tab,
          key: getTabKey(tab),
          label: base,
          title: tab.path,
          dirty,
          iconUrl: getVscodeFileIconUrl(base),
        }
      }

      if (tab.kind === 'diff') {
        const base = getBaseName(tab.file)
        return {
          ...tab,
          key: getTabKey(tab),
          label: tab.staged ? `Diff (staged): ${base}` : `Diff: ${base}`,
          title: tab.file,
          iconUrl: getVscodeFileIconUrl(base),
        }
      }

      if (tab.kind === 'terminal') {
        const base = getBaseName(tab.cwd)
        return {
          ...tab,
          key: getTabKey(tab),
          label: base ? `Terminal: ${base}` : 'Terminal',
          title: tab.cwd,
          icon: <Terminal className="size-4" />,
        }
      }

      return {
        ...tab,
        key: getTabKey(tab),
        label: tab.panelId === 'project-summary' ? '汇总' : tab.panelId,
        title: tab.panelId === 'project-summary' ? '项目数据汇总' : tab.panelId,
        icon: <Folder className="size-4" />,
      }
    })
  }, [filePreviewByPath, tabs])

  const renderMain = () => {
    const terminalTabs = tabs.filter(
      (t): t is Extract<WorkspaceTab, { kind: 'terminal' }> => t.kind === 'terminal',
    )
    const isTerminalView = activeView.kind === 'terminal'
    const activeTerminalId = isTerminalView ? activeView.id : ''
    const activeTab = terminalTabs.find((t) => t.id === activeTerminalId) ?? null
    const cwd = activeTab ? activeTab.cwd.trim() || workspacePath : workspacePath
    const terminalStatus = terminalStatusById[activeTerminalId] ?? 'closed'
    const terminalStatusError = terminalErrorById[activeTerminalId] ?? null
    const statusLabel =
      terminalStatus === 'connected'
        ? '已连接'
        : terminalStatus === 'connecting'
          ? '连接中…'
          : terminalStatus === 'error'
            ? '连接错误'
            : '未连接'

    const terminalPanel = (
      <div
        className={cn(
          'h-full min-h-0 overflow-hidden flex flex-col',
          isTerminalView ? '' : 'hidden',
        )}
      >
        <div className="shrink-0 border-b px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">Terminal</div>
                <div className="text-[11px] text-muted-foreground">{statusLabel}</div>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={cwd}>
                {cwd || '（未设置工作目录）'}
              </div>
              {terminalStatusError ? (
                <div className="mt-1 text-xs text-destructive">{terminalStatusError}</div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!cwd}
                onClick={() => terminalSessionsRef.current[activeTerminalId]?.restart()}
              >
                重启
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!activeTab}
                onClick={() => {
                  terminalSessionsRef.current[activeTerminalId]?.terminate()
                  if (activeTab) closeTab(activeTab)
                }}
              >
                结束
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => terminalSessionsRef.current[activeTerminalId]?.clear()}
              >
                清屏
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!cwd}
                onClick={() => void openExternalTerminal(cwd)}
              >
                外部终端
              </Button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-black relative">
          {terminalTabs.map((t) => {
            const tabCwd = t.cwd.trim() || workspacePath
            const active = t.id === activeTerminalId
            return (
              <TerminalSession
                key={t.id}
                ref={(handle) => {
                  terminalSessionsRef.current[t.id] = handle
                }}
                id={t.id}
                cwd={tabCwd}
                ariaLabel="Project terminal"
                options={{ cursorBlink: true }}
                autoFocus={active}
                className={cn('absolute inset-0', active ? '' : 'hidden')}
                onStatusChange={(status, err) => {
                  setTerminalStatusById((prev) => ({ ...prev, [t.id]: status }))
                  setTerminalErrorById((prev) => ({ ...prev, [t.id]: err ?? null }))
                }}
              />
            )
          })}
        </div>
      </div>
    )

    if (activeView.kind === 'panel') {
      if (activeView.panelId === 'project-summary') {
        if (!project) {
          return (
            <>
              {terminalPanel}
              <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Spinner /> 加载中…
                </span>
              </div>
            </>
          )
        }
        return (
          <>
            {terminalPanel}
            <ProjectSummaryPanel project={project} />
          </>
        )
      }

      return (
        <>
          {terminalPanel}
          <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">
            未知面板：{activeView.panelId}
          </div>
        </>
      )
    }

    if (activeView.kind === 'terminal') {
      return <>{terminalPanel}</>
    }

    if (activeView.kind === 'output') {
      return (
        <>
          {terminalPanel}
          <div ref={setDetailsPortalTarget} className="h-full min-h-0 overflow-hidden" />
        </>
      )
    }

    if (activeView.kind === 'diff') {
      const key = getTabKey({ kind: 'diff', file: activeView.file, staged: activeView.staged })
      const preview = diffPreviewByFile[key]
      if (!preview || preview.loading) {
        return (
          <>
            {terminalPanel}
            <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Spinner /> 加载中…
              </span>
            </div>
          </>
        )
      }

      if (preview.error) {
        return (
          <>
            {terminalPanel}
            <div className="h-full min-h-0 overflow-auto px-4 py-6 text-sm text-destructive">
              {preview.error}
            </div>
          </>
        )
      }

      return (
        <>
          {terminalPanel}
          <div className="h-full min-h-0 overflow-hidden flex flex-col">
            <div className="shrink-0 border-b px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{getBaseName(activeView.file)}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={activeView.file}>
                    {activeView.staged ? 'Staged Changes' : 'Changes'}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant={diffViewMode === 'split' ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => setDiffViewMode('split')}
                  >
                    Split
                  </Button>
                  <Button
                    type="button"
                    variant={diffViewMode === 'unified' ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => setDiffViewMode('unified')}
                  >
                    Unified
                  </Button>
                </div>
              </div>

              {preview.truncated ? (
                <div className="mt-2 text-xs text-muted-foreground">Diff 已截断（仅展示前一部分）。</div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <DiffViewer diff={preview.diff} viewMode={diffViewMode} className="h-full" />
            </div>
          </div>
        </>
      )
    }

    if (activeView.kind === 'file') {
      const preview = filePreviewByPath[activeView.path]
      if (!preview || preview.loading) {
        return (
          <>
            {terminalPanel}
            <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Spinner /> 加载中…
              </span>
            </div>
          </>
        )
      }

      if (preview.error) {
        return (
          <>
            {terminalPanel}
            <div className="h-full min-h-0 overflow-auto px-4 py-6 text-sm text-destructive">
              {preview.error}
            </div>
          </>
        )
      }

      if (preview.isBinary) {
        return (
          <>
            {terminalPanel}
            <div className="h-full min-h-0 overflow-auto px-4 py-6 text-sm text-muted-foreground">
              该文件可能是二进制文件，暂不支持预览。
            </div>
          </>
        )
      }

      const canEdit = isConfigToml(activeView.path) && !preview.truncated
      const dirty = Boolean(preview.dirty)

      return (
        <>
          {terminalPanel}
          <div className="h-full min-h-0 overflow-hidden flex flex-col">
            {preview.truncated ? (
              <div className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                内容已截断（仅展示前一部分）。
              </div>
            ) : null}
            {canEdit ? (
              <div className="shrink-0 border-b px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {getBaseName(activeView.path)}
                      {dirty ? '（未保存）' : ''}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px] text-muted-foreground"
                      title={activeView.path}
                    >
                      {activeView.path}
                    </div>
                    {preview.saveError ? (
                      <div className="mt-1 text-xs text-destructive">{preview.saveError}</div>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!dirty || preview.saving}
                      onClick={() => void saveFileDraft(activeView.path)}
                    >
                      保存
                      {preview.saving ? <Spinner /> : null}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!dirty || preview.saving}
                      onClick={() => revertFileDraft(activeView.path)}
                    >
                      还原
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">
              {canEdit ? (
                <MonacoCode
                  code={preview.draft}
                  filePath={activeView.path}
                  className="h-full"
                  readOnly={false}
                  onChange={(value) => updateFileDraft(activeView.path, value)}
                  onSelectionChange={(selection: MonacoCodeSelection | null) => {
                    if (!selection) {
                      setCodeSelection(null)
                      return
                    }

                    setCodeSelection({
                      filePath: activeView.path,
                      startLine: selection.startLine,
                      endLine: selection.endLine,
                      text: selection.text,
                    })
                  }}
                />
              ) : preview.content ? (
                <MonacoCode
                  code={preview.content}
                  filePath={activeView.path}
                  className="h-full"
                  onSelectionChange={(selection: MonacoCodeSelection | null) => {
                    if (!selection) {
                      setCodeSelection(null)
                      return
                    }

                    setCodeSelection({
                      filePath: activeView.path,
                      startLine: selection.startLine,
                      endLine: selection.endLine,
                      text: selection.text,
                    })
                  }}
                />
              ) : (
                <div className="px-4 py-4 text-xs text-muted-foreground">（空文件）</div>
              )}
            </div>
          </div>
        </>
      )
    }

    return (
      <>
        {terminalPanel}
        <div className="flex h-full min-h-0 items-center justify-center text-center">
          <div className="max-w-sm">
            <div className="text-sm font-medium">No tabs open</div>
            <div className="mt-1 text-xs text-muted-foreground">
              预览一个文件，或打开终端开始工作。
            </div>
            <div className="mt-4 flex items-center justify-center gap-2">
              <Button type="button" variant="outline" onClick={() => openTerminal({ focus: true })}>
                打开终端
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setActiveView({ kind: 'output' })}
              >
                工具输出
              </Button>
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-hidden flex flex-col">
      {error ? (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className={cn('min-h-0 flex-1 overflow-hidden flex', toolsPanelOpen ? 'gap-4' : '')}>
        <section
          className={cn(
            'min-h-0 overflow-hidden rounded-lg border bg-card flex flex-col',
            toolsPanelOpen ? 'w-[620px] shrink-0' : 'flex-1',
          )}
        >
          {project ? (
            <ProjectChat
              key={project.id}
              project={project}
              detailsOpen={detailsOpen}
              detailsPortalTarget={detailsPortalTarget}
              activeFilePath={activeView.kind === 'file' ? activeView.path : null}
              codeSelection={codeSelection}
              onClearCodeSelection={() => setCodeSelection(null)}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden p-4 text-sm text-muted-foreground">
              {loading ? '加载中…' : '未找到项目。'}
            </div>
          )}
        </section>

        {toolsPanelOpen && project ? (
          <aside className="min-w-0 flex-1 overflow-hidden rounded-lg border bg-card flex flex-col">
            <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
              <div className="flex items-center gap-1">
                {!fileManagerOpen ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="打开文件管理"
                    onClick={() => setFileManagerOpen(true)}
                  >
                    <Folder className="size-4" />
                  </Button>
                ) : null}

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="终端"
                  onClick={() => openTerminal({ focus: true })}
                >
                  <Terminal className="size-4" />
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="工具输出"
                  onClick={() => setActiveView({ kind: 'output' })}
                >
                  <FileText className="size-4" />
                </Button>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="收起工具栏"
                onClick={() => setToolsPanelOpen(false)}
              >
                <PanelRightClose className="size-4" />
              </Button>
            </div>

            <div ref={workspaceBodyRef} className="min-h-0 flex-1 overflow-hidden flex">
              {fileManagerOpen ? (
                <>
                  <div className="shrink-0 overflow-hidden" style={{ width: fileManagerWidthPx }}>
                    <ProjectFileManager
                      workspacePath={workspacePath}
                      projectId={project?.id ?? null}
                      onRequestClose={() => setFileManagerOpen(false)}
                      onOpenFile={openFile}
                      onOpenDiff={openDiff}
                      onOpenTerminal={(path) => openTerminal({ path, focus: true })}
                      className="h-full"
                    />
                  </div>

                  <div
                    role="separator"
                    aria-orientation="vertical"
                    className={cn(
                      'w-1 shrink-0 cursor-col-resize bg-border/30',
                      'hover:bg-border/60',
                      resizing ? 'bg-border' : '',
                    )}
                    onPointerDown={startResize}
                    onPointerMove={moveResize}
                    onPointerUp={stopResize}
                    onPointerCancel={stopResize}
                  />
                </>
              ) : null}

              <div className="min-w-0 flex-1 overflow-hidden flex flex-col">
                <div className="shrink-0 border-b px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <TabStrip
                      className="min-w-0 flex-1"
                      items={mainTabs}
                      activeKey={tryGetViewKey(activeView)}
                      ariaLabel="Workspace tabs"
                      onActivate={(tab) => {
                        if (tab.kind === 'file') {
                          setActiveView({ kind: 'file', path: tab.path })
                          return
                        }
                        if (tab.kind === 'diff') {
                          setActiveView({ kind: 'diff', file: tab.file, staged: tab.staged })
                          return
                        }
                        if (tab.kind === 'terminal') {
                          setActiveView({ kind: 'terminal', id: tab.id })
                          return
                        }
                        setActiveView({ kind: 'panel', panelId: tab.panelId })
                      }}
                      onClose={(tab) => closeTab(tab)}
                    />
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden">{renderMain()}</div>
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      <Button
        type="button"
        variant="outline"
        size="icon"
        className={cn(
          'fixed right-4 top-4 z-40 shadow-md transition-[opacity,transform] duration-200 ease-out',
          toolsPanelOpen ? 'pointer-events-none translate-y-1 opacity-0 scale-95' : 'opacity-100',
        )}
        title="展开工具栏"
        onClick={() => setToolsPanelOpen(true)}
      >
        <PanelRightOpen className="size-4" />
        <span className="sr-only">展开工具栏</span>
      </Button>
    </div>
  )
  },
)
