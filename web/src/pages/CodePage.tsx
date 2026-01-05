import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '@/api/client'
import type { ProjectDto, ToolType } from '@/api/types'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/Modal'
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
import { ChevronDown, FileText, Folder, RefreshCw, Search, Terminal, X } from 'lucide-react'

const SELECTED_PROJECT_STORAGE_KEY = 'onecode:code:selected-project-id:v1'

function CodePageHeader({
  pickerAnchorRef,
  pickerOpen,
  pickerButtonLabel,
  onTogglePicker,
  onOpenMenu,
  actionsAnchorRef,
  actionsOpen,
  onToggleActions,
  scanning,
  showScanButton,
  onScan,
}: {
  pickerAnchorRef: RefObject<HTMLButtonElement | null>
  pickerOpen: boolean
  pickerButtonLabel: string
  onTogglePicker: () => void
  onOpenMenu: (e: ReactMouseEvent<HTMLButtonElement>) => void
  actionsAnchorRef: RefObject<HTMLButtonElement | null>
  actionsOpen: boolean
  onToggleActions: () => void
  scanning: boolean
  showScanButton: boolean
  onScan: () => void
}) {
  return (
    <header className="shrink-0 flex h-8 items-center justify-between gap-3">
      <div className="min-w-0">
        <button
          ref={pickerAnchorRef}
          type="button"
          className={cn(
            'group inline-flex h-8 max-w-full items-center gap-2 rounded-md border px-2 text-left text-sm font-medium',
            'bg-background shadow-xs',
            'transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out',
            'hover:bg-accent hover:text-accent-foreground',
            'active:scale-[0.98]',
            pickerOpen && 'bg-accent text-accent-foreground shadow-sm',
          )}
          onClick={onTogglePicker}
          onContextMenu={onOpenMenu}
        >
          <Folder className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-current" />
          <span className="truncate">{pickerButtonLabel}</span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 ease-out group-hover:text-current',
              pickerOpen && 'rotate-180',
            )}
          />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button asChild variant="outline" size="sm" className="group">
          <button
            ref={actionsAnchorRef}
            type="button"
            onClick={onToggleActions}
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            title="更多功能"
          >
            更多功能
            <ChevronDown
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 ease-out group-hover:text-current',
                actionsOpen && 'rotate-180',
              )}
            />
          </button>
        </Button>
        {showScanButton ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={scanning}
            onClick={onScan}
            title="扫描 Codex sessions 并创建项目"
          >
            {scanning ? (
              <span className="inline-flex items-center gap-2">
                <Spinner /> 扫描中
              </span>
            ) : (
              <>
                <Search className="size-4" />
                扫描项目
              </>
            )}
          </Button>
        ) : null}
      </div>
    </header>
  )
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
      const status = await api.tools.status('codex')
      workspaceRef.current?.openFile(status.configPath)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [closeActionsMenu])

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

  const startScan = useCallback((opts?: { force?: boolean }) => {
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
  }, [appendScanLog, initialLoadDone, loadProjects, projects.length, scanning])

  useEffect(() => {
    void loadProjects()
    return () => {
      scanEventSourceRef.current?.close()
      scanEventSourceRef.current = null
    }
  }, [loadProjects])

  useEffect(() => {
    startScan()
  }, [startScan])

  const selectedProject = useMemo(() => {
    if (!projectIdFromQuery) return null
    return projects.find((p) => p.id === projectIdFromQuery) ?? null
  }, [projectIdFromQuery, projects])

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
    const base = selectedProject.toolType === 'Codex' ? '/codex' : '/claude'
    navigate(`${base}?tab=projects`)
  }, [closeProjectMenu, navigate, selectedProject])

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
        onScan={() => startScan({ force: true })}
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
          <div className="rounded-lg border bg-card p-4 animate-in fade-in-0 duration-200">
            <div className="text-sm font-medium">先选择一个项目</div>
            <div className="mt-1 text-xs text-muted-foreground">
              选择后会打开工作区，并将路由固定为 <code className="px-1">/code?projects=id</code>。
            </div>

            {!projects.length ? (
              <div className="mt-4 space-y-3">
                <div className="text-sm text-muted-foreground">
                  {scanning ? '正在自动扫描项目…' : '暂无项目。'}
                </div>
                {scanLogs.length ? (
                  <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                    {scanLogs.join('\n')}
                  </pre>
                ) : null}
                {scanning ? (
                  <Button type="button" variant="outline" onClick={stopScan}>
                    停止扫描
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={cn(
                      'rounded-md border bg-background p-3 text-left',
                      'transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out',
                      'hover:bg-accent/40 hover:border-border hover:shadow-sm',
                      'active:scale-[0.99]',
                    )}
                    onClick={() => selectProject(p.id)}
                  >
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{p.workspacePath}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="h-full min-h-0 animate-in fade-in-0 duration-200">
            <ProjectWorkspacePage
              ref={workspaceRef}
              key={selectedProject.id}
              projectId={selectedProject.id}
            />
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
