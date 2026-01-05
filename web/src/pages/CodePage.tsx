import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, formatUtc } from '@/api/client'
import type { ProjectDto, ProjectSessionDto, ToolStatusDto, ToolType } from '@/api/types'
import { cn } from '@/lib/utils'
import { SessionTraceBar, TokenUsageColumnChart } from '@/components/CodexSessionViz'
import { Modal } from '@/components/Modal'
import { CodePageHeader } from '@/pages/code/CodePageHeader'
import { ProjectSelectionCard } from '@/pages/code/ProjectSelectionCard'
import { ProjectUpsertModal } from '@/pages/code/ProjectUpsertModal'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ProjectWorkspacePage, type ProjectWorkspaceHandle } from '@/pages/ProjectWorkspacePage'
import { FileText, Folder, RefreshCw, Terminal, X } from 'lucide-react'

const SELECTED_PROJECT_STORAGE_KEY = 'onecode:code:selected-project-id:v1'

type SessionsCacheEntry = {
  cachedAt: number
  sessions: ProjectSessionDto[]
}

const sessionsCache = new Map<string, SessionsCacheEntry>()
const sessionsCacheTtlMs = 60_000

function sumSessionTokens(s: ProjectSessionDto): number {
  return (
    (s.tokenUsage?.inputTokens ?? 0) +
    (s.tokenUsage?.cachedInputTokens ?? 0) +
    (s.tokenUsage?.outputTokens ?? 0) +
    (s.tokenUsage?.reasoningOutputTokens ?? 0)
  )
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)

  if (hours > 0) return `${hours}小时${minutes}分`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'

  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  const stripTrailingZero = (raw: string) =>
    raw.endsWith('.0') ? raw.slice(0, -2) : raw

  if (abs < 1000) return value.toLocaleString()

  if (abs < 1_000_000) {
    const n = abs / 1000
    const decimals = n >= 100 ? 0 : 1
    return `${sign}${stripTrailingZero(n.toFixed(decimals))}K`
  }

  if (abs < 1_000_000_000) {
    const n = abs / 1_000_000
    const decimals = n >= 100 ? 0 : 1
    return `${sign}${stripTrailingZero(n.toFixed(decimals))}M`
  }

  const n = abs / 1_000_000_000
  const decimals = n >= 100 ? 0 : 1
  return `${sign}${stripTrailingZero(n.toFixed(decimals))}B`
}

function readStoredProjectId(): string | null {
  try {
    const v = localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY)
    return v ? v : null
  } catch {
    return null
  }
}

function writeStoredProjectId(id: string) {
  try {
    localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, id)
  } catch {
    // ignore
  }
}

function clearStoredProjectId() {
  try {
    localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY)
  } catch {
    // ignore
  }
}

function normalizeProjectQueryId(raw: string | null): string | null {
  const v = (raw ?? '').trim()
  return v ? v : null
}

function mergeProjects(a: ProjectDto[], b: ProjectDto[]): ProjectDto[] {
  const map = new Map<string, ProjectDto>()
  for (const p of [...a, ...b]) map.set(p.id, p)
  const merged = Array.from(map.values())
  merged.sort((x, y) => {
    const ax = Date.parse(x.updatedAtUtc || x.createdAtUtc)
    const ay = Date.parse(y.updatedAtUtc || y.createdAtUtc)
    if (!Number.isNaN(ax) && !Number.isNaN(ay) && ax !== ay) return ay - ax
    return x.name.localeCompare(y.name)
  })
  return merged
}

export function CodePage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const projectIdFromQuery = normalizeProjectQueryId(
    searchParams.get('projects') ?? searchParams.get('project'),
  )

  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [loading, setLoading] = useState(false)
  const [initialLoadDone, setInitialLoadDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [codexStatus, setCodexStatus] = useState<ToolStatusDto | null>(null)

  const [scanning, setScanning] = useState(false)
  const [scanLogs, setScanLogs] = useState<string[]>([])
  const scanEventSourceRef = useRef<EventSource | null>(null)
  const autoScanAttemptedRef = useRef(false)

  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerAnchorRef = useRef<HTMLButtonElement | null>(null)
  const pickerMenuRef = useRef<HTMLDivElement | null>(null)
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  )
  const pickerCloseTimerRef = useRef<number | null>(null)
  const [pickerMenuMounted, setPickerMenuMounted] = useState(false)
  const [pickerMenuState, setPickerMenuState] = useState<'open' | 'closed'>('closed')

  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null)
  const closeProjectMenu = useCallback(() => setProjectMenu(null), [])

  const workspaceRef = useRef<ProjectWorkspaceHandle | null>(null)

  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const actionsAnchorRef = useRef<HTMLButtonElement | null>(null)
  const actionsMenuRef = useRef<HTMLDivElement | null>(null)
  const [actionsMenuPos, setActionsMenuPos] = useState<
    { top: number; left: number; width: number } | null
  >(null)
  const closeActionsMenu = useCallback(() => setActionsMenuOpen(false), [])

  const [upsertOpen, setUpsertOpen] = useState(false)
  const [upsertMode, setUpsertMode] = useState<'create' | 'edit'>('create')
  const [upsertTarget, setUpsertTarget] = useState<ProjectDto | null>(null)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const closePicker = useCallback(() => setPickerOpen(false), [])

  const toggleActionsMenu = useCallback(() => {
    setActionsMenuOpen((open) => {
      const next = !open
      if (next) {
        closePicker()
        closeProjectMenu()
      }
      return next
    })
  }, [closePicker, closeProjectMenu])

  const openCreateProject = useCallback(() => {
    closeActionsMenu()
    closePicker()
    closeProjectMenu()
    setUpsertMode('create')
    setUpsertTarget(null)
    setUpsertOpen(true)
  }, [closeActionsMenu, closePicker, closeProjectMenu])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      if (pickerCloseTimerRef.current) {
        window.clearTimeout(pickerCloseTimerRef.current)
        pickerCloseTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    if (pickerOpen) {
      if (pickerCloseTimerRef.current) {
        window.clearTimeout(pickerCloseTimerRef.current)
        pickerCloseTimerRef.current = null
      }
      setPickerMenuMounted(true)
      setPickerMenuState('open')
      return
    }

    if (!pickerMenuMounted) return
    setPickerMenuState('closed')
    if (pickerCloseTimerRef.current) return

    pickerCloseTimerRef.current = window.setTimeout(() => {
      setPickerMenuMounted(false)
      pickerCloseTimerRef.current = null
    }, 200)
  }, [pickerMenuMounted, pickerOpen])

  useEffect(() => {
    if (typeof window === 'undefined') return

    if (!actionsMenuOpen) {
      setActionsMenuPos(null)
      return
    }

    const anchor = actionsAnchorRef.current
    if (!anchor) return

    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const width = 240
      const maxLeft = Math.max(8, window.innerWidth - width - 8)
      setActionsMenuPos({
        top: rect.bottom + 6,
        left: Math.min(rect.left, maxLeft),
        width,
      })
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) return
      const menu = actionsMenuRef.current
      if (menu && menu.contains(target)) return
      if (anchor.contains(target)) return
      closeActionsMenu()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeActionsMenu()
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [actionsMenuOpen, closeActionsMenu])

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const toolTypes: ToolType[] = ['Codex', 'ClaudeCode']
      const [codex, claude] = await Promise.all(toolTypes.map((t) => api.projects.list(t)))
      setProjects(mergeProjects(codex, claude))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
      setInitialLoadDone(true)
    }
  }, [])

  const loadCodexStatus = useCallback(async (): Promise<ToolStatusDto | null> => {
    try {
      const status = await api.tools.status('codex')
      setCodexStatus(status)
      return status
    } catch (e) {
      setError((e as Error).message)
      setCodexStatus(null)
      return null
    }
  }, [])

  const refreshProjectsList = useCallback(() => {
    closeActionsMenu()
    void loadProjects()
  }, [closeActionsMenu, loadProjects])

  const openProjectSummary = useCallback(() => {
    closeActionsMenu()
    workspaceRef.current?.openProjectSummary()
  }, [closeActionsMenu])

  const openWorkspaceTerminal = useCallback(() => {
    closeActionsMenu()
    closeProjectMenu()
    workspaceRef.current?.openTerminal({ focus: true })
  }, [closeActionsMenu, closeProjectMenu])

  const openCodexConfigToml = useCallback(async () => {
    closeActionsMenu()
    try {
      const status = await loadCodexStatus()
      if (!status) return
      workspaceRef.current?.openFile(status.configPath)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [closeActionsMenu, loadCodexStatus])

  const appendScanLog = useCallback((line: string) => {
    setScanLogs((prev) => {
      const next = [...prev, line]
      if (next.length > 200) next.splice(0, next.length - 200)
      return next
    })
  }, [])

  const stopScan = useCallback(() => {
    scanEventSourceRef.current?.close()
    scanEventSourceRef.current = null
    setScanning(false)
  }, [])

  const startScan = useCallback(async (opts?: { force?: boolean }) => {
    if (scanning) return
    const force = Boolean(opts?.force)
    if (!force) {
      if (!initialLoadDone) return
      if (autoScanAttemptedRef.current) return
      if (projects.length) return
    }

    autoScanAttemptedRef.current = true
    setScanLogs([])
    setScanning(true)

    scanEventSourceRef.current?.close()
    scanEventSourceRef.current = null

    appendScanLog('执行：codex -V')
    const status = await loadCodexStatus()
    if (!status?.installed) {
      appendScanLog('未检测到 Codex CLI：请先安装 Codex，然后重试。')
      setScanning(false)
      return
    }

    appendScanLog(`Codex 版本：${status.version ?? '—'}`)

    const eventSource = api.projects.scanCodexSessions('Codex')
    scanEventSourceRef.current = eventSource

    eventSource.addEventListener('log', (e) => {
      appendScanLog((e as MessageEvent).data as string)
    })

    eventSource.addEventListener('done', (e) => {
      const raw = (e as MessageEvent).data as string
      appendScanLog(raw ? `完成：${raw}` : '完成：扫描已结束。')
      eventSource.close()
      scanEventSourceRef.current = null
      setScanning(false)
      void loadProjects()
    })

    eventSource.onerror = () => {
      appendScanLog('连接已中断（可能已完成或服务器异常）。')
      eventSource.close()
      scanEventSourceRef.current = null
      setScanning(false)
    }
  }, [appendScanLog, initialLoadDone, loadCodexStatus, loadProjects, projects.length, scanning])

  useEffect(() => {
    void loadProjects()
    void loadCodexStatus()
    return () => {
      scanEventSourceRef.current?.close()
      scanEventSourceRef.current = null
    }
  }, [loadCodexStatus, loadProjects])

  useEffect(() => {
    void startScan()
  }, [startScan])

  const selectedProject = useMemo(() => {
    if (!projectIdFromQuery) return null
    return projects.find((p) => p.id === projectIdFromQuery) ?? null
  }, [projectIdFromQuery, projects])

  const [sessions, setSessions] = useState<ProjectSessionDto[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [copyResumeHint, setCopyResumeHint] = useState<string | null>(null)

  const selectedProjectId = selectedProject?.id ?? null

  const loadSessions = useCallback(
    async ({ force }: { force?: boolean } = {}) => {
      const project = selectedProject
      if (!project) {
        setSessions([])
        setSessionsError(null)
        setSessionsLoading(false)
        return
      }

      const cached = sessionsCache.get(project.id)
      const isFresh = cached && Date.now() - cached.cachedAt < sessionsCacheTtlMs

      if (!force && cached && isFresh) {
        setSessions(cached.sessions)
        setSessionsError(null)
        setSessionsLoading(false)
        setSelectedSessionId((current) => {
          if (!current) return current
          return cached.sessions.some((s) => s.id === current) ? current : null
        })
        return
      }

      setSessionsLoading(true)
      setSessionsError(null)
      try {
        const data = await api.projects.sessions(project.id)
        sessionsCache.set(project.id, { cachedAt: Date.now(), sessions: data })
        setSessions(data)
        setSelectedSessionId((current) => {
          if (!current) return current
          return data.some((s) => s.id === current) ? current : null
        })
      } catch (e) {
        setSessionsError((e as Error).message)
      } finally {
        setSessionsLoading(false)
      }
    },
    [selectedProject],
  )

  useEffect(() => {
    setCopyResumeHint(null)
  }, [selectedProjectId, selectedSessionId])

  useEffect(() => {
    if (!selectedProjectId) {
      setSessions([])
      setSelectedSessionId(null)
      setSessionsError(null)
      setSessionsLoading(false)
      return
    }

    // 默认不选择会话；切换项目时清空选择并重新加载会话列表。
    setSelectedSessionId(null)
    setSessions([])
    setSessionsError(null)
    setSessionsLoading(true)
    void loadSessions()
  }, [loadSessions, selectedProjectId])

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null
    return sessions.find((s) => s.id === selectedSessionId) ?? null
  }, [selectedSessionId, sessions])

  useEffect(() => {
    if (projectIdFromQuery) return
    if (!projects.length) return

    const stored = readStoredProjectId()
    if (!stored) return
    if (!projects.some((p) => p.id === stored)) return

    const sp = new URLSearchParams(searchParams)
    sp.set('projects', stored)
    setSearchParams(sp, { replace: true })
  }, [projectIdFromQuery, projects, searchParams, setSearchParams])

  useEffect(() => {
    if (!pickerOpen) return
    const anchor = pickerAnchorRef.current
    if (!anchor) return

    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.max(260, rect.width)
      const maxLeft = Math.max(8, window.innerWidth - width - 8)
      setPickerPos({
        top: rect.bottom + 6,
        left: Math.min(rect.left, maxLeft),
        width,
      })
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) return
      const menu = pickerMenuRef.current
      if (menu && menu.contains(target)) return
      if (anchor.contains(target)) return
      closePicker()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePicker()
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closePicker, pickerOpen])

  useEffect(() => {
    if (!projectMenu) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeProjectMenu()
    }

    const onScroll = () => closeProjectMenu()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [closeProjectMenu, projectMenu])

  const selectProject = useCallback(
    (id: string) => {
      writeStoredProjectId(id)
      const sp = new URLSearchParams(searchParams)
      sp.set('projects', id)
      setSearchParams(sp, { replace: false })
      closePicker()
      closeProjectMenu()
    },
    [closePicker, closeProjectMenu, searchParams, setSearchParams],
  )

  const clearSelection = useCallback(() => {
    clearStoredProjectId()
    const sp = new URLSearchParams(searchParams)
    sp.delete('projects')
    sp.delete('project')
    setSearchParams(sp, { replace: false })
    closePicker()
    closeProjectMenu()
  }, [closePicker, closeProjectMenu, searchParams, setSearchParams])

  const openProjectMenu = useCallback(
    (e: ReactMouseEvent) => {
      if (!selectedProject) return
      e.preventDefault()
      e.stopPropagation()
      closePicker()

      if (typeof window === 'undefined') return
      const menuWidth = 220
      const menuHeight = 180
      const x = Math.min(e.clientX, Math.max(0, window.innerWidth - menuWidth))
      const y = Math.min(e.clientY, Math.max(0, window.innerHeight - menuHeight))
      setProjectMenu({ x, y })
    },
    [closePicker, selectedProject],
  )

  const openRename = useCallback(() => {
    if (!selectedProject) return
    setRenameDraft(selectedProject.name)
    setRenameError(null)
    setRenameBusy(false)
    setRenameOpen(true)
    closeProjectMenu()
  }, [closeProjectMenu, selectedProject])

  const submitRename = useCallback(async () => {
    if (!selectedProject) return
    const name = renameDraft.trim()
    if (!name) {
      setRenameError('名称不能为空')
      return
    }

    if (name === selectedProject.name) {
      setRenameOpen(false)
      return
    }

    setRenameBusy(true)
    setRenameError(null)
    try {
      await api.projects.update(selectedProject.id, {
        toolType: selectedProject.toolType,
        name,
        workspacePath: selectedProject.workspacePath,
        providerId: selectedProject.providerId,
        model: selectedProject.model,
      })
      setRenameOpen(false)
      await loadProjects()
    } catch (e) {
      setRenameError((e as Error).message)
    } finally {
      setRenameBusy(false)
    }
  }, [loadProjects, renameDraft, selectedProject])

  const openEdit = useCallback(() => {
    if (!selectedProject) return
    closeProjectMenu()
    setUpsertMode('edit')
    setUpsertTarget(selectedProject)
    setUpsertOpen(true)
  }, [closeProjectMenu, selectedProject])

  const openDelete = useCallback(() => {
    if (!selectedProject) return
    setDeleteError(null)
    setDeleteBusy(false)
    setDeleteDialogOpen(true)
    closeProjectMenu()
  }, [closeProjectMenu, selectedProject])

  const confirmDelete = useCallback(async () => {
    if (!selectedProject) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await api.projects.delete(selectedProject.id)
      clearSelection()
      setDeleteDialogOpen(false)
      await loadProjects()
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleteBusy(false)
    }
  }, [clearSelection, loadProjects, selectedProject])

  const pickerButtonLabel = useMemo(() => {
    if (selectedProject) return selectedProject.name
    return '选择项目'
  }, [selectedProject])

  const showProjectPickerMenu = Boolean(
    typeof document !== 'undefined' && pickerMenuMounted && pickerPos,
  )
  const pickerPosValue = pickerPos

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <CodePageHeader
        pickerAnchorRef={pickerAnchorRef}
        pickerOpen={pickerOpen}
        pickerButtonLabel={pickerButtonLabel}
        onTogglePicker={() => {
          closeActionsMenu()
          setPickerOpen((v) => !v)
        }}
        onOpenMenu={(e) => {
          closeActionsMenu()
          openProjectMenu(e)
        }}
        actionsAnchorRef={actionsAnchorRef}
        actionsOpen={actionsMenuOpen}
        onToggleActions={toggleActionsMenu}
        scanning={scanning}
        showScanButton={!projects.length}
        onScan={() => void startScan({ force: true })}
      />

      {error ? (
        <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm animate-in fade-in-0 slide-in-from-top-2 duration-200">
          {error}
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1',
          selectedProject ? 'overflow-hidden' : 'overflow-y-auto',
        )}
      >
        {!selectedProject ? (
          <ProjectSelectionCard
            projects={projects}
            scanning={scanning}
            scanLogs={scanLogs}
            codexStatus={codexStatus}
            onSelectProject={selectProject}
            onCreateProject={openCreateProject}
            onScanProjects={() => void startScan({ force: true })}
            onStopScan={stopScan}
            onGoInstallCodex={() => navigate('/codex')}
          />
        ) : (
          <div className="h-full min-h-0 animate-in fade-in-0 duration-200 overflow-hidden flex flex-col gap-4 lg:flex-row">
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <ProjectWorkspacePage
                ref={workspaceRef}
                key={selectedProject.id}
                projectId={selectedProject.id}
              />
            </div>

            <aside className="min-h-0 overflow-hidden rounded-lg border bg-card flex flex-col lg:w-[380px]">
              <div className="shrink-0 border-b px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      会话 {sessions.length ? `（${sessions.length}）` : ''}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      默认不选择；点击会话加载记录并展示。
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={sessionsLoading}
                      onClick={() => void loadSessions({ force: true })}
                    >
                      刷新
                      {sessionsLoading ? <Spinner /> : null}
                    </Button>
                    {selectedSessionId ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedSessionId(null)}
                      >
                        取消选择
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {sessionsError ? (
                <div className="shrink-0 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {sessionsError}
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                <div
                  className={cn(
                    'min-h-0 flex-1 overflow-auto bg-background/30',
                    selectedSession ? 'border-b' : '',
                  )}
                >
                  {sessions.length ? (
                    <div className="space-y-1 p-2">
                      {sessions.map((s) => {
                        const isActive = s.id === selectedSessionId
                        const totalTokens = sumSessionTokens(s)
                        return (
                          <button
                            key={s.id}
                            type="button"
                            className={cn(
                              'w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors',
                              'hover:bg-accent/40',
                              isActive
                                ? 'border-border bg-accent/40'
                                : 'bg-transparent',
                            )}
                            onClick={() => setSelectedSessionId(s.id)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">
                                  {formatUtc(s.createdAtUtc)}
                                </div>
                                <div className="truncate text-[11px] text-muted-foreground">
                                  {s.id}
                                </div>
                              </div>
                              <div className="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                                <div>{formatDuration(s.durationMs)}</div>
                                <div
                                  title={`总计 ${totalTokens.toLocaleString()} Token`}
                                >
                                  {formatCompactNumber(totalTokens)} Token
                                </div>
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="px-3 py-6 text-sm text-muted-foreground">
                      {sessionsLoading ? '加载中…' : '未找到会话。'}
                    </div>
                  )}
                </div>

                {selectedSession ? (
                  <div className="shrink-0 max-h-[45%] overflow-auto p-3 space-y-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">
                        会话信息
                      </div>
                      <div className="text-sm font-medium">
                        {formatUtc(selectedSession.createdAtUtc)}
                      </div>
                      <div className="break-all text-[11px] text-muted-foreground">
                        {selectedSession.id}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        结束：{formatUtc(selectedSession.lastEventAtUtc)}
                      </div>
                    </div>

                    <div className="rounded-md border bg-background/40 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-xs font-medium text-muted-foreground">
                          Token
                        </div>
                        <div
                          className="text-xs text-muted-foreground tabular-nums"
                          title={`总计 ${sumSessionTokens(selectedSession).toLocaleString()} Token`}
                        >
                          {formatCompactNumber(sumSessionTokens(selectedSession))}{' '}
                          Token
                        </div>
                      </div>
                      <div className="mt-2">
                        <TokenUsageColumnChart usage={selectedSession.tokenUsage} />
                      </div>
                    </div>

                    {selectedSession.trace?.length ? (
                      <div className="rounded-md border bg-background/40 p-3">
                        <div className="text-xs font-medium text-muted-foreground">
                          时间线
                        </div>
                        <div className="mt-2">
                          <SessionTraceBar
                            trace={selectedSession.trace ?? []}
                            durationMs={selectedSession.durationMs}
                            collapseWaiting
                            waitingClampMs={30_000}
                          />
                        </div>
                        <div className="mt-2 text-[11px] text-muted-foreground">
                          鼠标移入色块：类型 / Token / 次数 / 时长。
                        </div>
                      </div>
                    ) : null}

                    {selectedProject.toolType === 'Codex' ? (
                      <div className="rounded-md border bg-background/40 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-medium text-muted-foreground">
                            codex resume
                          </div>
                          {copyResumeHint ? (
                            <div className="text-[11px] text-muted-foreground">
                              {copyResumeHint}
                            </div>
                          ) : null}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-[11px]">
                            codex resume {selectedSession.id}
                          </code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const command = `codex resume ${selectedSession.id}`
                              void (async () => {
                                try {
                                  await navigator.clipboard.writeText(command)
                                  setCopyResumeHint('已复制')
                                } catch {
                                  setCopyResumeHint('复制失败')
                                }
                              })()
                            }}
                          >
                            复制
                          </Button>
                        </div>
                        <div className="mt-2 text-[11px] text-muted-foreground">
                          可用 <code className="px-1">--last</code> 自动恢复最近会话，
                          或指定 <code className="px-1">SESSION_ID</code> 恢复指定会话。
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="shrink-0 border-t p-3 text-sm text-muted-foreground">
                    请选择右侧会话以查看记录；不选择则保持当前工作区对话为新会话。
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>

      {actionsMenuOpen && actionsMenuPos && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={actionsMenuRef}
              className="fixed z-50 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 duration-200 ease-out"
              style={{
                top: actionsMenuPos.top,
                left: actionsMenuPos.left,
                width: actionsMenuPos.width,
              }}
              role="menu"
            >
              <div className="px-3 py-2 text-xs text-muted-foreground">更多功能</div>
              <div className="h-px bg-border" />
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                disabled={loading || scanning}
                onClick={refreshProjectsList}
              >
                {loading ? <Spinner /> : <RefreshCw className="size-4 text-muted-foreground" />}
                {loading ? '刷新中' : '刷新项目列表'}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                disabled={scanning}
                onClick={openCreateProject}
              >
                <Folder className="size-4 text-muted-foreground" />
                新建项目
              </button>
              <div className="h-px bg-border" />
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                disabled={!selectedProject}
                onClick={openProjectSummary}
              >
                <FileText className="size-4 text-muted-foreground" />
                项目数据汇总
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                disabled={!selectedProject}
                onClick={openWorkspaceTerminal}
              >
                <Terminal className="size-4 text-muted-foreground" />
                打开终端
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                disabled={!selectedProject}
                onClick={() => void openCodexConfigToml()}
              >
                <FileText className="size-4 text-muted-foreground" />
                打开 config.toml
              </button>
            </div>,
            document.body,
          )
        : null}

      {showProjectPickerMenu && pickerPosValue
        ? createPortal(
            <div
              ref={pickerMenuRef}
              data-state={pickerMenuState}
              className={cn(
                'fixed z-50 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md',
                'data-[state=open]:animate-in data-[state=closed]:animate-out',
                'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
                'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
                'data-[state=open]:slide-in-from-top-2 data-[state=closed]:slide-out-to-top-2',
                'data-[state=closed]:pointer-events-none',
                'duration-200 ease-out',
              )}
              style={{
                top: pickerPosValue.top,
                left: pickerPosValue.left,
                width: pickerPosValue.width,
              }}
              role="menu"
            >
              <div className="flex items-center justify-between gap-2 border-b px-2 py-2">
                <div className="text-xs text-muted-foreground">项目</div>
                {selectedProject ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={clearSelection}
                  >
                    <X className="size-3" />
                    取消选择
                  </button>
                ) : null}
              </div>

              <div className="max-h-[60vh] overflow-auto p-1">
                {!projects.length ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    暂无项目
                  </div>
                ) : (
                  projects.map((p) => {
                    const active = selectedProject?.id === p.id
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="menuitem"
                        className={cn(
                          'flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left text-sm transition-colors',
                          active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent',
                        )}
                        onClick={() => selectProject(p.id)}
                      >
                        <Folder className={cn('mt-0.5 size-4 shrink-0', active ? 'text-inherit' : 'text-muted-foreground')} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{p.name}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            {p.workspacePath}
                          </span>
                        </span>
                      </button>
                    )
                  })
                )}
              </div>

              {scanning ? (
                <div className="border-t px-3 py-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> 正在扫描…
                  </span>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}

      {projectMenu && selectedProject && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-50"
              onMouseDown={closeProjectMenu}
              onContextMenu={(e) => {
                e.preventDefault()
                closeProjectMenu()
              }}
              role="presentation"
            >
              <div
                className="fixed min-w-[200px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 duration-200 ease-out"
                style={{ left: projectMenu.x, top: projectMenu.y }}
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
                role="menu"
              >
                <div className="px-3 py-2 text-xs text-muted-foreground truncate">
                  {selectedProject.name}
                </div>
                <div className="h-px bg-border" />
                <button
                  type="button"
                  className="flex w-full items-center px-3 py-2 text-sm hover:bg-accent"
                  onClick={openEdit}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="flex w-full items-center px-3 py-2 text-sm hover:bg-accent"
                  onClick={openRename}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="flex w-full items-center px-3 py-2 text-sm hover:bg-accent"
                  onClick={openWorkspaceTerminal}
                >
                  打开终端
                </button>
                <div className="h-px bg-border" />
                <button
                  type="button"
                  className="flex w-full items-center px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                  onClick={openDelete}
                >
                  删除
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}

      <ProjectUpsertModal
        open={upsertOpen}
        mode={upsertMode}
        project={upsertMode === 'edit' ? upsertTarget : null}
        defaultToolType={selectedProject?.toolType ?? 'Codex'}
        onClose={() => {
          setUpsertOpen(false)
          setUpsertTarget(null)
        }}
        onSaved={(project) => {
          setUpsertOpen(false)
          setUpsertTarget(null)
          void loadProjects().then(() => selectProject(project.id))
        }}
      />

      <Modal
        open={renameOpen}
        title="重命名项目"
        onClose={() => {
          if (renameBusy) return
          setRenameOpen(false)
          setRenameError(null)
        }}
      >
        <div className="space-y-3">
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            autoFocus
            disabled={renameBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitRename()
              }
            }}
          />
          {renameError ? <div className="text-sm text-destructive">{renameError}</div> : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={renameBusy}
              onClick={() => {
                if (renameBusy) return
                setRenameOpen(false)
                setRenameError(null)
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={renameBusy || !renameDraft.trim()}
              onClick={() => void submitRename()}
            >
              保存
            </Button>
          </div>
        </div>
      </Modal>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setDeleteDialogOpen(true)
            return
          }
          if (deleteBusy) return
          setDeleteDialogOpen(false)
          setDeleteError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除“{selectedProject?.name ?? ''}”吗？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <div className="text-sm text-destructive">{deleteError}</div> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteBusy}
              onClick={(e) => {
                e.preventDefault()
                void confirmDelete()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
