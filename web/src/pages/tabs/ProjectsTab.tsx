import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { api, formatUtc } from '@/api/client'
import type {
  ProjectDto,
  ProjectUpsertRequest,
  ProviderDto,
  ToolType,
} from '@/api/types'
import { cn } from '@/lib/utils'
import { DirectoryPicker } from '@/components/DirectoryPicker'
import { Modal } from '@/components/Modal'
import { MoreHorizontal } from 'lucide-react'
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
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ProjectSessionsView } from '@/pages/tabs/ProjectSessionsView'

type FormState = {
  name: string
  workspacePath: string
  providerId: string | null
  model: string
}

function emptyForm(): FormState {
  return { name: '', workspacePath: '', providerId: null, model: '' }
}

type BatchFormState = {
  updateProvider: boolean
  providerId: string | null
  updateModel: boolean
  model: string
}

function emptyBatchForm(): BatchFormState {
  return { updateProvider: false, providerId: null, updateModel: false, model: '' }
}

const providerDefaultSentinel = '__onecode_provider_default__'

export function ProjectsTab({ toolType }: { toolType: ToolType }) {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [providers, setProviders] = useState<ProviderDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openActionsId, setOpenActionsId] = useState<string | null>(null)
  const [mountedActionsId, setMountedActionsId] = useState<string | null>(null)
  const [sessionsProject, setSessionsProject] = useState<ProjectDto | null>(null)

  const actionsMenuRef = useRef<HTMLDivElement | null>(null)
  const actionsAnchorRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [actionsMenuPos, setActionsMenuPos] = useState<{
    top: number
    left: number
  } | null>(null)

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectAllRef = useRef<HTMLInputElement | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ProjectDto | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())

  const [batchEditOpen, setBatchEditOpen] = useState(false)
  const [batchForm, setBatchForm] = useState<BatchFormState>(emptyBatchForm())

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectDto | null>(null)

  const [batchDeleteDialogOpen, setBatchDeleteDialogOpen] = useState(false)

  const [scanOpen, setScanOpen] = useState(false)
  const [scanRunning, setScanRunning] = useState(false)
  const [scanLogs, setScanLogs] = useState<string[]>([])
  const scanEventSourceRef = useRef<EventSource | null>(null)
  const scanLogEndRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [p, prov] = await Promise.all([
        api.projects.list(toolType),
        api.providers.list(),
      ])
      setProjects(p)
      setProviders(prov)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [toolType])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const ids = new Set(projects.map((p) => p.id))
    setSelectedIds((prev) => prev.filter((id) => ids.has(id)))
  }, [projects])

  useEffect(() => {
    if (openActionsId) {
      setMountedActionsId(openActionsId)
      return
    }

    if (!mountedActionsId) return
    const t = window.setTimeout(() => setMountedActionsId(null), 150)
    return () => window.clearTimeout(t)
  }, [mountedActionsId, openActionsId])

  useEffect(() => {
    if (!openActionsId) return

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) return

      const menu = actionsMenuRef.current
      if (menu && menu.contains(target)) return

      const root = target.closest('[data-actions-id]')
      if (root && root.getAttribute('data-actions-id') === openActionsId) return

      setOpenActionsId(null)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenActionsId(null)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openActionsId])

  useEffect(() => {
    if (!openActionsId) return

    const anchor = actionsAnchorRefs.current[openActionsId]
    if (!anchor) return

    const update = () => {
      const rect = anchor.getBoundingClientRect()
      setActionsMenuPos({ top: rect.bottom + 4, left: rect.right })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [openActionsId])

  const openProject = useCallback(
    (id: string) => {
      navigate(`/code?projects=${encodeURIComponent(id)}`)
    },
    [navigate],
  )

  const appendScanLog = useCallback((line: string) => {
    setScanLogs((prev) => {
      const next = [...prev, line]
      if (next.length > 500) next.splice(0, next.length - 500)
      return next
    })
  }, [])

  useEffect(() => {
    return () => {
      scanEventSourceRef.current?.close()
      scanEventSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!scanOpen) return
    scanLogEndRef.current?.scrollIntoView({ block: 'end' })
  }, [scanLogs, scanOpen])

  const selectableProjectIds = useMemo(() => {
    return projects.map((p) => p.id)
  }, [projects])

  const allSelected = useMemo(() => {
    return (
      selectableProjectIds.length > 0 &&
      selectedIds.length === selectableProjectIds.length
    )
  }, [selectableProjectIds.length, selectedIds.length])

  const someSelected = useMemo(() => {
    return (
      selectedIds.length > 0 &&
      selectedIds.length < selectableProjectIds.length
    )
  }, [selectableProjectIds.length, selectedIds.length])

  useEffect(() => {
    if (!selectAllRef.current) return
    selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  const filteredProviders = useMemo(() => {
    if (toolType === 'Codex') {
      return providers.filter((p) => p.requestType !== 'Anthropic')
    }
    return providers.filter((p) => p.requestType === 'Anthropic')
  }, [providers, toolType])

  const selectedProvider = useMemo(() => {
    if (!form.providerId) return null
    return providers.find((p) => p.id === form.providerId) ?? null
  }, [form.providerId, providers])

  const batchSelectedProvider = useMemo(() => {
    if (!batchForm.providerId) return null
    return providers.find((p) => p.id === batchForm.providerId) ?? null
  }, [batchForm.providerId, providers])

  const toolLabel = toolType === 'Codex' ? 'Codex' : 'Claude Code'

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm())
    setModalOpen(true)
  }

  const openBatchEdit = useCallback(() => {
    if (!selectedIds.length) return
    const selectedProjects = projects.filter((p) => selectedIdSet.has(p.id))
    const first = selectedProjects[0]
    if (!first) return

    const sameProvider = selectedProjects.every(
      (p) => p.providerId === first.providerId,
    )
    const sameModel = selectedProjects.every(
      (p) => (p.model ?? '') === (first.model ?? ''),
    )

    setBatchForm({
      updateProvider: false,
      providerId: sameProvider ? first.providerId : null,
      updateModel: false,
      model: sameModel ? first.model ?? '' : '',
    })
    setBatchEditOpen(true)
  }, [projects, selectedIdSet, selectedIds.length])

  const closeScanModal = useCallback(() => {
    scanEventSourceRef.current?.close()
    scanEventSourceRef.current = null
    setScanRunning(false)
    setScanOpen(false)
  }, [])

  const stopScan = useCallback(() => {
    if (!scanRunning) return
    scanEventSourceRef.current?.close()
    scanEventSourceRef.current = null
    setScanRunning(false)
    appendScanLog('已停止扫描。')
  }, [appendScanLog, scanRunning])

  const startScan = useCallback(() => {
    if (scanRunning) return
    setScanLogs([])
    setScanOpen(true)
    setScanRunning(true)

    scanEventSourceRef.current?.close()
    const eventSource = api.projects.scanCodexSessions(toolType)
    scanEventSourceRef.current = eventSource

    eventSource.addEventListener('log', (e) => {
      appendScanLog((e as MessageEvent).data as string)
    })

    eventSource.addEventListener('done', (e) => {
      const raw = (e as MessageEvent).data as string
      try {
        const summary = JSON.parse(raw) as {
          scannedFiles: number
          uniqueCwds: number
          created: number
          skippedExisting: number
          skippedMissingWorkspace: number
          readErrors: number
          jsonErrors: number
        }
        const scannedLabel = toolType === 'Codex' ? '扫描文件' : '扫描目录'
        appendScanLog(
          `完成：${scannedLabel} ${summary.scannedFiles}，cwd ${summary.uniqueCwds}，创建 ${summary.created}，跳过已存在 ${summary.skippedExisting}，跳过不存在目录 ${summary.skippedMissingWorkspace}。`,
        )
        if (summary.readErrors || summary.jsonErrors) {
          appendScanLog(
            `提示：读取错误 ${summary.readErrors}，JSON 解析错误 ${summary.jsonErrors}（详情见上方日志）。`,
          )
        }
      } catch {
        appendScanLog(`完成：${raw}`)
      }

      eventSource.close()
      scanEventSourceRef.current = null
      setScanRunning(false)
      void load()
    })

    eventSource.onerror = () => {
      appendScanLog('连接已中断（可能已完成或服务器异常）。')
      eventSource.close()
      scanEventSourceRef.current = null
      setScanRunning(false)
    }
  }, [appendScanLog, load, scanRunning, toolType])

  const openEdit = (p: ProjectDto) => {
    setEditing(p)
    setForm({
      name: p.name,
      workspacePath: p.workspacePath,
      providerId: p.providerId,
      model: p.model ?? '',
    })
    setModalOpen(true)
  }

  const canSubmit = useMemo(() => {
    if (!form.name.trim()) return false
    if (!form.workspacePath.trim()) return false
    return true
  }, [form.name, form.workspacePath])

  const canSubmitBatch = useMemo(() => {
    if (!selectedIds.length) return false
    if (!batchForm.updateProvider && !batchForm.updateModel) return false
    return true
  }, [batchForm.updateModel, batchForm.updateProvider, selectedIds.length])

  const submit = async () => {
    setLoading(true)
    setError(null)
    const payload: ProjectUpsertRequest = {
      toolType,
      name: form.name.trim(),
      workspacePath: form.workspacePath.trim(),
      providerId: form.providerId,
      model: form.model.trim() ? form.model.trim() : null,
    }

    try {
      if (editing) {
        await api.projects.update(editing.id, payload)
      } else {
        await api.projects.create(payload)
      }
      setModalOpen(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const submitBatch = async () => {
    if (!selectedIds.length) return
    if (!batchForm.updateProvider && !batchForm.updateModel) return

    setLoading(true)
    setError(null)
    try {
      const selectedProjects = projects.filter((p) => selectedIdSet.has(p.id))

      for (const p of selectedProjects) {
        const payload: ProjectUpsertRequest = {
          toolType,
          name: p.name,
          workspacePath: p.workspacePath,
          providerId: batchForm.updateProvider ? batchForm.providerId : p.providerId,
          model: batchForm.updateModel
            ? batchForm.model.trim()
              ? batchForm.model.trim()
              : null
            : p.model ?? null,
        }
        await api.projects.update(p.id, payload)
      }

      setBatchEditOpen(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const openRemove = (p: ProjectDto) => {
    setDeleteTarget(p)
    setDeleteDialogOpen(true)
  }

  const remove = async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      await api.projects.delete(id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const confirmRemove = async () => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleteDialogOpen(false)
    setDeleteTarget(null)
    await remove(id)
  }

  const removeSelected = async () => {
    if (!selectedIds.length) return
    setLoading(true)
    setError(null)
    try {
      for (const id of selectedIds) {
        await api.projects.delete(id)
      }
      setSelectedIds([])
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const start = async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      await api.projects.start(id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const startSelected = async () => {
    if (!selectedIds.length) return
    setLoading(true)
    setError(null)
    try {
      for (const id of selectedIds) {
        await api.projects.start(id)
      }
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const modelDatalistId = useMemo(() => {
    return `models-${toolType}`
  }, [toolType])

  const batchModelDatalistId = useMemo(() => {
    return `models-batch-${toolType}`
  }, [toolType])

  const actionsProject = useMemo(() => {
    if (!mountedActionsId) return null
    return projects.find((p) => p.id === mountedActionsId) ?? null
  }, [mountedActionsId, projects])

  if (sessionsProject) {
    return (
      <ProjectSessionsView
        project={sessionsProject}
        onBack={() => setSessionsProject(null)}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium">项目管理</div>
          <div className="text-xs text-muted-foreground">
            项目可绑定提供商；未绑定则使用系统默认配置。支持配置模型并一键启动。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={startScan}
            disabled={scanRunning}
          >
            自动扫描项目
          </Button>
          <Button type="button" onClick={openCreate}>
            添加项目
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">
              项目列表 {loading ? '（处理中…）' : ''}
            </div>
            {selectedIds.length ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="text-xs text-muted-foreground">
                  已选 {selectedIds.length}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedIds([])}
                  disabled={loading}
                >
                  清空选择
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={openBatchEdit}
                  disabled={loading}
                >
                  批量设置
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void startSelected()}
                  disabled={loading}
                >
                  批量启动
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => setBatchDeleteDialogOpen(true)}
                  disabled={loading}
                >
                  批量删除
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[64rem] table-fixed text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="sticky left-0 z-20 w-[16rem] border-r bg-card px-4 py-2 text-left">
                  <div className="flex items-center gap-2">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      className="size-4 rounded border-input bg-background"
                      aria-label="全选"
                      checked={allSelected}
                      disabled={!selectableProjectIds.length || loading}
                      onChange={(e) => {
                        const checked = e.target.checked
                        setSelectedIds(checked ? selectableProjectIds : [])
                      }}
                    />
                    <span>名称</span>
                  </div>
                </th>
                <th className="px-4 py-2 text-left">工作空间</th>
                <th className="w-[9rem] px-4 py-2 text-left whitespace-nowrap">
                  提供商
                </th>
                <th className="w-[11rem] px-4 py-2 text-left whitespace-nowrap">
                  模型
                </th>
                <th className="sticky right-0 z-20 w-[6rem] border-l bg-card px-4 py-2 text-right whitespace-nowrap">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.length ? (
                projects.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 border-r bg-card px-4 py-2">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 rounded border-input bg-background"
                          aria-label={`选择 ${p.name}`}
                          checked={selectedIdSet.has(p.id)}
                          disabled={loading}
                          onChange={(e) => {
                            const checked = e.target.checked
                            setSelectedIds((prev) => {
                              if (checked) {
                                return prev.includes(p.id) ? prev : [...prev, p.id]
                              }
                              return prev.filter((id) => id !== p.id)
                            })
                          }}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium" title={p.name}>
                            {p.name}
                          </div>
                          {p.lastStartedAtUtc ? (
                            <div className="text-xs text-muted-foreground">
                              上次启动：{formatUtc(p.lastStartedAtUtc)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="truncate" title={p.workspacePath}>
                        {p.workspacePath}
                      </div>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {p.providerName ? (
                        <div className="truncate" title={p.providerName}>
                          {p.providerName}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">默认配置</span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {p.model ? (
                        <div className="truncate" title={p.model}>
                          {p.model}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">（未指定）</span>
                      )}
                    </td>
                    <td className="sticky right-0 z-10 border-l bg-card px-4 py-2 text-right whitespace-nowrap">
                      <div
                        className="relative inline-flex justify-end"
                        data-actions-id={p.id}
                        ref={(el) => {
                          actionsAnchorRefs.current[p.id] = el
                        }}
                      >
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="outline"
                          aria-haspopup="menu"
                          aria-expanded={openActionsId === p.id}
                          aria-controls={
                            mountedActionsId === p.id
                              ? `project-actions-${p.id}`
                              : undefined
                          }
                          title="操作"
                          onClick={() => {
                            setOpenActionsId((current) => {
                              const next = current === p.id ? null : p.id
                              if (next) {
                                setMountedActionsId(next)
                                const anchor = actionsAnchorRefs.current[next]
                                if (anchor) {
                                  const rect = anchor.getBoundingClientRect()
                                  setActionsMenuPos({
                                    top: rect.bottom + 4,
                                    left: rect.right,
                                  })
                                }
                              }
                              return next
                            })
                          }}
                        >
                          <MoreHorizontal className="size-4" />
                          <span className="sr-only">操作</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={5}>
                    还没有项目，先添加一个吧。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {typeof document !== 'undefined' && actionsProject && actionsMenuPos
        ? createPortal(
            <div
              id={`project-actions-${actionsProject.id}`}
              ref={actionsMenuRef}
              role="menu"
              data-state={
                openActionsId === actionsProject.id ? 'open' : 'closed'
              }
              className={cn(
                'fixed z-50 w-36 origin-top-right -translate-x-full rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
                'data-[state=open]:animate-in data-[state=closed]:animate-out',
                'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
                'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
                'duration-150',
                openActionsId !== actionsProject.id && 'pointer-events-none',
              )}
              style={{ top: actionsMenuPos.top, left: actionsMenuPos.left }}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setOpenActionsId(null)
                  openProject(actionsProject.id)
                }}
              >
                打开
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setOpenActionsId(null)
                  setSessionsProject(actionsProject)
                }}
              >
                所有会话
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setOpenActionsId(null)
                  void start(actionsProject.id)
                }}
              >
                启动
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setOpenActionsId(null)
                  openEdit(actionsProject)
                }}
              >
                编辑
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                onClick={() => {
                  setOpenActionsId(null)
                  openRemove(actionsProject)
                }}
              >
                删除
              </button>
            </div>,
            document.body,
          )
        : null}

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open)
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除项目「{deleteTarget?.name ?? ''}」？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={loading}
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => void confirmRemove()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={batchDeleteDialogOpen}
        onOpenChange={(open) => {
          setBatchDeleteDialogOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认批量删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除已选的 {selectedIds.length} 个项目？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={loading || !selectedIds.length}
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                setBatchDeleteDialogOpen(false)
                void removeSelected()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Modal
        open={modalOpen}
        title={editing ? '编辑项目' : '添加项目'}
        onClose={() => setModalOpen(false)}
        className="max-w-3xl"
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">项目名</div>
            <Input
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="例如：OneCode"
            />
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">工作空间目录</div>
            <DirectoryPicker
              value={form.workspacePath}
              onChange={(path) => setForm((s) => ({ ...s, workspacePath: path }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">
                绑定提供商（可选）
              </div>
              <Select
                value={form.providerId ?? providerDefaultSentinel}
                onValueChange={(value) =>
                  setForm((s) => ({
                    ...s,
                    providerId: value === providerDefaultSentinel ? null : value,
                  }))
                }
              >
                <SelectTrigger className="h-9 w-full bg-background px-3 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={providerDefaultSentinel}>默认配置</SelectItem>
                  {filteredProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.requestType})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {toolType === 'ClaudeCode' ? (
                <div className="text-xs text-muted-foreground">
                  Claude Code 仅支持 Anthropic 兼容提供商
                </div>
              ) : null}
            </div>

            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">模型（可选）</div>
              <Input
                list={selectedProvider?.models?.length ? modelDatalistId : undefined}
                value={form.model}
                onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))}
                placeholder={
                  selectedProvider
                    ? '可直接输入或从列表选择'
                    : toolType === 'Codex'
                      ? '例如：gpt-5.1-codex-max'
                      : '例如：claude-3-5-sonnet-latest'
                }
              />
              {selectedProvider?.models?.length ? (
                <datalist id={modelDatalistId}>
                  {selectedProvider.models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              ) : null}
              {selectedProvider ? (
                <div className="text-xs text-muted-foreground">
                  当前提供商已缓存 {selectedProvider.models.length} 个模型（可在“提供商管理”中拉取更新）
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit || loading}
            >
              保存
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={batchEditOpen}
        title="批量设置"
        onClose={() => setBatchEditOpen(false)}
        className="max-w-3xl"
      >
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            将对已选的 {selectedIds.length} 个项目生效；未勾选的字段不会被修改。
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input bg-background"
                  checked={batchForm.updateProvider}
                  onChange={(e) =>
                    setBatchForm((s) => ({ ...s, updateProvider: e.target.checked }))
                  }
                />
                更新提供商
              </label>
              <Select
                value={batchForm.providerId ?? providerDefaultSentinel}
                disabled={!batchForm.updateProvider}
                onValueChange={(value) =>
                  setBatchForm((s) => ({
                    ...s,
                    providerId: value === providerDefaultSentinel ? null : value,
                  }))
                }
              >
                <SelectTrigger
                  className={cn(
                    'h-9 w-full bg-background px-3 text-sm',
                    !batchForm.updateProvider && 'opacity-60',
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={providerDefaultSentinel}>默认配置</SelectItem>
                  {filteredProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.requestType})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {toolType === 'ClaudeCode' ? (
                <div className="text-xs text-muted-foreground">
                  Claude Code 仅支持 Anthropic 兼容提供商
                </div>
              ) : null}
            </div>

            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input bg-background"
                  checked={batchForm.updateModel}
                  onChange={(e) =>
                    setBatchForm((s) => ({ ...s, updateModel: e.target.checked }))
                  }
                />
                更新模型
              </label>
              <Input
                disabled={!batchForm.updateModel}
                list={
                  batchSelectedProvider?.models?.length ? batchModelDatalistId : undefined
                }
                value={batchForm.model}
                onChange={(e) => setBatchForm((s) => ({ ...s, model: e.target.value }))}
                placeholder={
                  batchForm.updateModel
                    ? '留空表示清空模型'
                    : '（未启用）'
                }
              />
              {batchSelectedProvider?.models?.length ? (
                <datalist id={batchModelDatalistId}>
                  {batchSelectedProvider.models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              ) : null}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setBatchEditOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void submitBatch()}
              disabled={!canSubmitBatch || loading}
            >
              保存
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={scanOpen}
        title="自动扫描项目"
        onClose={closeScanModal}
        className="max-w-3xl"
      >
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            {toolType === 'Codex' ? (
              <>
                扫描 <span className="font-medium text-foreground">{toolLabel}</span>{' '}
                sessions（<code className="px-1">~/.codex/sessions</code>）下所有
                jsonl 文件的首行，读取 <code className="px-1">payload.cwd</code>{' '}
                并自动创建项目。
              </>
            ) : (
              <>
                扫描 <span className="font-medium text-foreground">{toolLabel}</span>{' '}
                projects（<code className="px-1">~/.claude/projects</code>）下所有项目目录，
                读取会话日志中的 <code className="px-1">cwd</code> 并自动创建项目。
              </>
            )}
          </div>
          <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">
            <div className="max-h-[55vh] overflow-y-auto">
              {scanLogs.length ? scanLogs.join('\n') : '等待扫描日志…'}
              <div ref={scanLogEndRef} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            {scanRunning ? (
              <Button type="button" variant="outline" onClick={stopScan}>
                停止扫描
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={closeScanModal}>
              关闭
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
