import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router-dom'
import { api } from '@/api/client'
import type {
  DirectoryEntryDto,
  FileEntryDto,
  ListEntriesResponse,
  ProjectDto,
} from '@/api/types'
import { cn } from '@/lib/utils'
import {
  FileItem,
  Files,
  FolderContent,
  FolderItem,
  FolderTrigger,
  SubFiles,
} from '@animate-ui/components-base-files'
import { Modal } from '@/components/Modal'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

type FsEntryKind = 'file' | 'directory'

type FsEntryTarget = {
  kind: FsEntryKind
  name: string
  fullPath: string
}

function normalizePathForComparison(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

function getParentPath(fullPath: string): string | null {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return null

  const parent = normalized.slice(0, lastSeparator)
  if (!parent) return null
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`
  return parent
}

function getBaseName(fullPath: string): string {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return normalized
  const base = normalized.slice(lastSeparator + 1)
  return base || normalized
}

function splitFileSystemPath(path: string): string[] {
  const normalized = path.replace(/\//g, '\\').replace(/[\\]+$/, '')
  return normalized.split('\\').filter(Boolean)
}

function getRelativePath(fromPath: string, toPath: string): string | null {
  const fromParts = splitFileSystemPath(fromPath)
  const toParts = splitFileSystemPath(toPath)

  if (!fromParts.length || !toParts.length) return null

  const fromRoot = fromParts[0].toLowerCase()
  const toRoot = toParts[0].toLowerCase()
  if (fromRoot !== toRoot) return null

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common].toLowerCase() === toParts[common].toLowerCase()
  ) {
    common += 1
  }

  const up = new Array(Math.max(0, fromParts.length - common)).fill('..')
  const down = toParts.slice(common)
  const combined = [...up, ...down]
  return combined.join('\\') || '.'
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall back
    }
  }

  try {
    if (typeof document === 'undefined') return false
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

function FsContextMenu({
  open,
  x,
  y,
  onClose,
  children,
}: {
  open: boolean
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    const onScroll = () => onClose()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onClose])

  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
      role="presentation"
    >
      <div
        className="fixed min-w-[240px] max-w-[320px] max-h-[calc(100vh-16px)] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

type ChatRole = 'user' | 'agent' | 'system'

type ChatMessage = {
  id: string
  role: ChatRole
  text: string
}

type CodexEventLogItem = {
  receivedAtUtc: string
  method?: string
  raw: string
}

type A2aStatusUpdate = {
  taskId: string
  contextId: string
  final?: boolean
  status?: {
    state?: string
    timestamp?: string
    message?: {
      role?: string
      messageId?: string
      taskId?: string
      contextId?: string
      parts?: unknown[]
    }
  }
}

type A2aArtifactUpdate = {
  taskId: string
  contextId: string
  append?: boolean
  lastChunk?: boolean
  artifact?: {
    artifactId?: string
    name?: string
    parts?: unknown[]
  }
}

function getApiBase(): string {
  return (
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:5210'
  )
}

function randomId(prefix = 'id'): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return `${prefix}-${crypto.randomUUID()}`
    }
  } catch {
    // fall back
  }

  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

async function* readSseText(response: Response): AsyncGenerator<string, void, unknown> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let dataLines: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const rawLine = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)

      const line = rawLine.replace(/\r$/, '')
      if (!line) {
        if (dataLines.length) {
          yield dataLines.join('\n')
          dataLines = []
        }
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }

      idx = buffer.indexOf('\n')
    }

    if (done) {
      if (dataLines.length) {
        yield dataLines.join('\n')
      }
      break
    }
  }
}

function readPartsText(parts: unknown[] | undefined): string {
  if (!parts?.length) return ''
  const chunks: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as { text?: unknown }
    if (typeof p.text === 'string' && p.text) chunks.push(p.text)
  }
  return chunks.join('')
}

function ProjectChatAndDetails({ project }: { project: ProjectDto }) {
  const apiBase = useMemo(() => getApiBase(), [])
  const sessionIdRef = useRef<string>(randomId('ctx'))

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [detailsOpen, setDetailsOpen] = useState(true)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [reasoning, setReasoning] = useState('')
  const [toolOutput, setToolOutput] = useState('')
  const [diffText, setDiffText] = useState('')
  const [tokenUsage, setTokenUsage] = useState<unknown>(null)
  const [rawEvents, setRawEvents] = useState<CodexEventLogItem[]>([])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const updateAgentMessage = useCallback((messageId: string, updater: (prev: string) => string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, text: updater(m.text) } : m)),
    )
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return

    setChatError(null)
    setDraft('')
    setReasoning('')
    setToolOutput('')
    setDiffText('')
    setTokenUsage(null)
    setRawEvents([])

    const taskId = randomId('task')
    const userMessageId = `msg-user-${taskId}`
    const agentMessageId = `msg-agent-${taskId}`

    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: 'user', text },
      { id: agentMessageId, role: 'agent', text: '' },
    ])

    setSending(true)
    setThinkingOpen(true)
    setActiveTaskId(taskId)
    setCanceling(false)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const request = {
        jsonrpc: '2.0',
        id: randomId('req'),
        method: 'tasks/sendSubscribe',
        params: {
          cwd: project.workspacePath,
          contextId: sessionIdRef.current,
          taskId,
          message: {
            role: 'user',
            messageId: userMessageId,
            contextId: sessionIdRef.current,
            taskId,
            parts: [{ text }],
          },
        },
      }

      const res = await fetch(`${apiBase}/a2a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(errText || `${res.status} ${res.statusText}`)
      }

      for await (const data of readSseText(res)) {
        if (!data) continue

        let payload: any
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }

        if (payload?.error) {
          throw new Error(payload?.error?.message ?? 'A2A error')
        }

        const result = payload?.result ?? null
        if (!result) continue

        const statusUpdate = (result.statusUpdate ?? null) as A2aStatusUpdate | null
        if (statusUpdate?.status?.message?.messageId) {
          const messageId = statusUpdate.status.message.messageId
          const parts = statusUpdate.status.message.parts as unknown[] | undefined
          const chunk = readPartsText(parts)

          if (messageId === agentMessageId && chunk) {
            if (statusUpdate.final) {
              updateAgentMessage(agentMessageId, () => chunk)
            } else {
              updateAgentMessage(agentMessageId, (prev) => prev + chunk)
            }
          }

          if (statusUpdate.final) {
            setThinkingOpen(false)
            setSending(false)
            setActiveTaskId(null)
            setCanceling(false)
          }
        }

        const artifactUpdate = (result.artifactUpdate ?? null) as A2aArtifactUpdate | null
        const artifact = artifactUpdate?.artifact
        const artifactName = artifact?.name ?? ''

        if (artifactName === 'reasoning') {
          const parts = (artifact?.parts ?? []) as unknown[]
          const chunk = readPartsText(parts)
          if (chunk) setReasoning((prev) => prev + chunk)
          continue
        }

        if (artifactName === 'tool-output' || artifactName === 'stderr') {
          const parts = (artifact?.parts ?? []) as unknown[]
          const chunk = readPartsText(parts)
          if (chunk) setToolOutput((prev) => prev + chunk)
          continue
        }

        if (artifactName === 'diff') {
          const parts = (artifact?.parts ?? []) as unknown[]
          const chunk = readPartsText(parts)
          if (chunk) setDiffText(chunk)
          continue
        }

        if (artifactName === 'token-usage') {
          const parts = (artifact?.parts ?? []) as any[]
          const firstData = parts?.find((p) => p && typeof p === 'object' && 'data' in p)?.data
          if (firstData !== undefined) setTokenUsage(firstData)
          continue
        }

        if (artifactName === 'codex-events') {
          const parts = (artifact?.parts ?? []) as any[]
          for (const part of parts) {
            const d = part?.data
            if (!d || typeof d !== 'object') continue
            const receivedAtUtc = String((d as any).receivedAtUtc ?? '')
            const method = typeof (d as any).method === 'string' ? (d as any).method : undefined
            const raw = typeof (d as any).raw === 'string' ? (d as any).raw : ''
            if (!raw) continue
            setRawEvents((prev) => [...prev, { receivedAtUtc, method, raw }])
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setChatError((e as Error).message)
      }
      setSending(false)
      setThinkingOpen(false)
      setActiveTaskId(null)
      setCanceling(false)
    }
  }, [apiBase, draft, project.workspacePath, sending, updateAgentMessage])

  const cancel = useCallback(async () => {
    if (!activeTaskId || !sending || canceling) return
    setCanceling(true)
    setChatError(null)

    try {
      const request = {
        jsonrpc: '2.0',
        id: randomId('req'),
        method: 'tasks/cancel',
        params: {
          id: activeTaskId,
        },
      }

      const res = await fetch(`${apiBase}/a2a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
      })

      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        const errText = typeof payload === 'string' ? payload : null
        throw new Error(errText || `${res.status} ${res.statusText}`)
      }

      if (payload?.error) {
        throw new Error(payload?.error?.message ?? '取消失败')
      }
    } catch (e) {
      setChatError((e as Error).message)
      setCanceling(false)
    }
  }, [activeTaskId, apiBase, canceling, sending])

  return (
    <>
      <section className="min-w-0 flex-1 overflow-hidden rounded-lg border bg-card flex flex-col">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{project.name}</div>
            <div className="truncate text-xs text-muted-foreground">{project.workspacePath}</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="outline" onClick={() => setDetailsOpen((v) => !v)}>
              {detailsOpen ? '隐藏详情' : '显示详情'}
            </Button>
          </div>
        </div>

        {chatError ? (
          <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {chatError}
          </div>
        ) : null}

        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 pt-6 pb-6">
          {messages.length ? null : (
            <div className="flex h-full min-h-[160px] items-center justify-center text-center">
              <div className="max-w-sm text-sm text-muted-foreground">
                在这里开始对话：输入问题或指令。
              </div>
            </div>
          )}

          <div className="space-y-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  'mx-auto flex w-full max-w-3xl py-1',
                  m.role === 'user' ? 'justify-end' : 'justify-start',
                )}
              >
                <div
                  className={cn(
                    'max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
                    m.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : m.role === 'agent'
                        ? 'bg-muted text-foreground'
                        : 'bg-accent text-accent-foreground',
                  )}
                >
                  {m.text || (m.role === 'agent' && sending ? '…' : '')}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t bg-card px-4 pb-4 pt-3">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-2xl border bg-background p-2 shadow-lg">
              <div className="flex items-end gap-2">
                <textarea
                  className="min-h-[44px] max-h-[180px] w-full flex-1 resize-none rounded-xl bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
                  placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                  value={draft}
                  disabled={sending}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                {sending ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void cancel()}
                    disabled={canceling}
                  >
                    {canceling ? '停止中…' : '停止'}
                  </Button>
                ) : (
                  <Button type="button" onClick={() => void send()} disabled={!draft.trim()}>
                    发送
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {detailsOpen ? (
        <aside className="w-[360px] shrink-0 overflow-hidden rounded-lg border bg-card flex flex-col">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="text-sm font-medium">详情</div>
            <Button type="button" variant="outline" onClick={() => setDetailsOpen(false)}>
              收起
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b px-3 py-2">
              <button
                type="button"
                className="flex w-full items-center justify-between text-sm"
                onClick={() => setThinkingOpen((v) => !v)}
              >
                <span>思考</span>
                <span className="text-xs text-muted-foreground">
                  {thinkingOpen ? '收起' : sending ? '展开（生成中）' : '展开'}
                </span>
              </button>
              {thinkingOpen ? (
                <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
                  {reasoning || (sending ? '（等待思考内容…）' : '（无）')}
                </pre>
              ) : null}
            </div>

            <div className="border-b px-3 py-2">
              <div className="text-sm">工具输出</div>
              <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
                {toolOutput || '（无）'}
              </pre>
            </div>

            <div className="border-b px-3 py-2">
              <div className="text-sm">Diff</div>
              <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre rounded-md bg-muted p-2 text-xs">
                {diffText || '（无）'}
              </pre>
            </div>

            <div className="border-b px-3 py-2">
              <div className="text-sm">Token</div>
              <pre className="mt-2 max-h-[160px] overflow-auto whitespace-pre rounded-md bg-muted p-2 text-xs">
                {tokenUsage ? JSON.stringify(tokenUsage, null, 2) : '（无）'}
              </pre>
            </div>

            <div className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm">Raw Events</div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!rawEvents.length}
                  onClick={() => setRawEvents([])}
                >
                  清空
                </Button>
              </div>
              <div className="mt-2 space-y-2">
                {rawEvents.length ? null : (
                  <div className="text-xs text-muted-foreground">（无）</div>
                )}
                {rawEvents.map((e, idx) => (
                  <div key={`${e.receivedAtUtc}-${idx}`} className="rounded-md border bg-background p-2">
                    <div className="truncate text-[11px] text-muted-foreground">
                      {e.receivedAtUtc} {e.method ?? ''}
                    </div>
                    <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap text-[11px]">
                      {e.raw}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      ) : (
        <aside className="w-10 shrink-0 overflow-hidden rounded-lg border bg-card flex items-center justify-center">
          <button
            type="button"
            className="text-xs text-muted-foreground"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
            onClick={() => setDetailsOpen(true)}
          >
            详情
          </button>
        </aside>
      )}
    </>
  )
}

export function ProjectWorkspacePage() {
  const { id } = useParams()
  const [project, setProject] = useState<ProjectDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fsNotice, setFsNotice] = useState<string | null>(null)
  const fsNoticeTimerRef = useRef<number | null>(null)

  const showFsNotice = useCallback((message: string) => {
    setFsNotice(message)
    if (typeof window === 'undefined') return

    if (fsNoticeTimerRef.current) {
      window.clearTimeout(fsNoticeTimerRef.current)
    }

    fsNoticeTimerRef.current = window.setTimeout(() => {
      setFsNotice(null)
      fsNoticeTimerRef.current = null
    }, 1800)
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      if (fsNoticeTimerRef.current) {
        window.clearTimeout(fsNoticeTimerRef.current)
      }
    }
  }, [])

  const [fsMenu, setFsMenu] = useState<{ x: number; y: number; target: FsEntryTarget } | null>(
    null,
  )

  const closeFsMenu = useCallback(() => setFsMenu(null), [])

  const openFsMenu = useCallback((e: ReactMouseEvent, target: FsEntryTarget) => {
    e.preventDefault()
    e.stopPropagation()
    if (typeof window === 'undefined') return

    const menuWidth = 240
    const menuHeight = 320
    const x = Math.min(e.clientX, Math.max(0, window.innerWidth - menuWidth))
    const y = Math.min(e.clientY, Math.max(0, window.innerHeight - menuHeight))
    setFsMenu({ x, y, target })
  }, [])

  const [renameTarget, setRenameTarget] = useState<FsEntryTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<FsEntryTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [createBusy, setCreateBusy] = useState(false)

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

  const inFlightRef = useRef<Set<string>>(new Set())
  const [entriesByPath, setEntriesByPath] = useState<
    Record<string, Pick<ListEntriesResponse, 'directories' | 'files'>>
  >({})
  const entriesByPathRef = useRef(entriesByPath)
  const [nodeLoadingByPath, setNodeLoadingByPath] = useState<Record<string, boolean>>({})
  const [nodeErrorByPath, setNodeErrorByPath] = useState<Record<string, string | null>>({})

  useEffect(() => {
    entriesByPathRef.current = entriesByPath
  }, [entriesByPath])

  const resetEntries = useCallback(() => {
    inFlightRef.current.clear()
    setEntriesByPath({})
    entriesByPathRef.current = {}
    setNodeLoadingByPath({})
    setNodeErrorByPath({})
  }, [])

  const ensureEntries = useCallback(
    async (path: string) => {
      const normalizedPath = path.trim()
      if (!normalizedPath) return
      if (entriesByPathRef.current[normalizedPath]) return
      if (inFlightRef.current.has(normalizedPath)) return

      inFlightRef.current.add(normalizedPath)
      setNodeLoadingByPath((s) => ({ ...s, [normalizedPath]: true }))
      setNodeErrorByPath((s) => ({ ...s, [normalizedPath]: null }))
      try {
        const data = await api.fs.listEntries(normalizedPath)
        setEntriesByPath((s) => {
          const next = {
            ...s,
            [normalizedPath]: { directories: data.directories, files: data.files },
            [data.currentPath]: { directories: data.directories, files: data.files },
          }
          entriesByPathRef.current = next
          return next
        })
      } catch (e) {
        setNodeErrorByPath((s) => ({ ...s, [normalizedPath]: (e as Error).message }))
      } finally {
        inFlightRef.current.delete(normalizedPath)
        setNodeLoadingByPath((s) => ({ ...s, [normalizedPath]: false }))
      }
    },
    [],
  )

  const invalidateFsCache = useCallback(
    (changedPath: string) => {
      const changedNorm = normalizePathForComparison(changedPath)
      const parentPath = getParentPath(changedPath)
      const parentNorm = parentPath ? normalizePathForComparison(parentPath) : null

      const shouldRemove = (key: string) => {
        const keyNorm = normalizePathForComparison(key)
        if (parentNorm && keyNorm === parentNorm) return true
        if (keyNorm === changedNorm) return true
        return keyNorm.startsWith(`${changedNorm}\\`) || keyNorm.startsWith(`${changedNorm}/`)
      }

      setEntriesByPath((s) => {
        const next: typeof s = {}
        for (const [key, value] of Object.entries(s)) {
          if (!shouldRemove(key)) next[key] = value
        }
        entriesByPathRef.current = next
        return next
      })

      setNodeLoadingByPath((s) => {
        const next: typeof s = {}
        for (const [key, value] of Object.entries(s)) {
          if (!shouldRemove(key)) next[key] = value
        }
        return next
      })

      setNodeErrorByPath((s) => {
        const next: typeof s = {}
        for (const [key, value] of Object.entries(s)) {
          if (!shouldRemove(key)) next[key] = value
        }
        return next
      })

      if (parentPath) {
        void ensureEntries(parentPath)
      }
    },
    [ensureEntries],
  )

  const handleCopyPath = useCallback(
    async (path: string) => {
      const ok = await copyTextToClipboard(path)
      showFsNotice(ok ? '已复制绝对路径' : '复制失败：请手动复制')
    },
    [showFsNotice],
  )

  const handleCopyRelativePath = useCallback(
    async (path: string) => {
      const root = (project?.workspacePath ?? '').trim()
      if (!root) {
        await handleCopyPath(path)
        return
      }

      const relative = getRelativePath(root, path)
      if (!relative) {
        await handleCopyPath(path)
        showFsNotice('已复制绝对路径（无法计算相对路径）')
        return
      }

      const ok = await copyTextToClipboard(relative)
      showFsNotice(ok ? '已复制相对路径' : '复制失败：请手动复制')
    },
    [handleCopyPath, project?.workspacePath, showFsNotice],
  )

  const handleRevealInExplorer = useCallback(
    async (path: string) => {
      try {
        await api.fs.revealInExplorer(path)
      } catch (e) {
        showFsNotice((e as Error).message)
      }
    },
    [showFsNotice],
  )

  const handleOpenTerminal = useCallback(
    async (path: string) => {
      try {
        await api.fs.openTerminal(path)
      } catch (e) {
        showFsNotice((e as Error).message)
      }
    },
    [showFsNotice],
  )

  const handleCopyName = useCallback(
    async (name: string) => {
      const ok = await copyTextToClipboard(name)
      showFsNotice(ok ? '已复制名称' : '复制失败：请手动复制')
    },
    [showFsNotice],
  )

  const createEntryAndRename = useCallback(
    async (kind: FsEntryKind, anchor: FsEntryTarget) => {
      if (createBusy) return

      const parentPath =
        anchor.kind === 'directory' ? anchor.fullPath : getParentPath(anchor.fullPath)
      if (!parentPath) {
        showFsNotice('无法确定父目录')
        return
      }

      const defaultName = kind === 'directory' ? '新建文件夹' : '新建文件.txt'
      const existing = entriesByPathRef.current[parentPath]
      const used = new Set<string>()
      if (existing) {
        for (const d of existing.directories) used.add(d.name.toLowerCase())
        for (const f of existing.files) used.add(f.name.toLowerCase())
      }

      const makeCandidate = (index: number) => {
        if (index <= 0) return defaultName
        if (kind === 'directory') return `${defaultName} (${index})`

        const dot = defaultName.lastIndexOf('.')
        if (dot > 0) {
          const base = defaultName.slice(0, dot)
          const ext = defaultName.slice(dot)
          return `${base} (${index})${ext}`
        }
        return `${defaultName} (${index})`
      }

      setCreateBusy(true)
      try {
        let createdPath: string | null = null
        for (let i = 0; i < 50; i += 1) {
          const candidate = makeCandidate(i)
          if (used.has(candidate.toLowerCase())) continue

          try {
            const created = await api.fs.createEntry({ parentPath, name: candidate, kind })
            createdPath = created.fullPath
            break
          } catch (e) {
            const message = (e as Error).message
            if (message.includes('Destination already exists')) continue
            throw e
          }
        }

        if (!createdPath) {
          showFsNotice('创建失败：名称冲突')
          return
        }

        invalidateFsCache(createdPath)

        const createdName = getBaseName(createdPath)
        setRenameTarget({ kind, name: createdName, fullPath: createdPath })
        setRenameDraft(createdName)
        setRenameBusy(false)
        setRenameError(null)
      } catch (e) {
        showFsNotice((e as Error).message)
      } finally {
        setCreateBusy(false)
      }
    },
    [createBusy, invalidateFsCache, showFsNotice],
  )

  const beginRename = useCallback((target: FsEntryTarget) => {
    setRenameTarget(target)
    setRenameDraft(target.name)
    setRenameBusy(false)
    setRenameError(null)
  }, [])

  const submitRename = useCallback(async () => {
    if (!renameTarget) return

    const newName = renameDraft.trim()
    if (!newName) {
      setRenameError('名称不能为空')
      return
    }

    if (newName === renameTarget.name) {
      setRenameTarget(null)
      setRenameError(null)
      return
    }

    setRenameBusy(true)
    setRenameError(null)
    try {
      await api.fs.renameEntry({ path: renameTarget.fullPath, newName })
      invalidateFsCache(renameTarget.fullPath)
      setRenameTarget(null)
      setRenameDraft('')
      showFsNotice('已重命名')
    } catch (e) {
      setRenameError((e as Error).message)
    } finally {
      setRenameBusy(false)
    }
  }, [invalidateFsCache, renameDraft, renameTarget, showFsNotice])

  const beginDelete = useCallback((target: FsEntryTarget) => {
    setDeleteTarget(target)
    setDeleteBusy(false)
    setDeleteError(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return

    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await api.fs.deleteEntry(deleteTarget.fullPath)
      invalidateFsCache(deleteTarget.fullPath)
      setDeleteTarget(null)
      showFsNotice('已删除')
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteTarget, invalidateFsCache, showFsNotice])

  useEffect(() => {
    resetEntries()
    if (!project?.workspacePath) return
    void ensureEntries(project.workspacePath)
  }, [ensureEntries, project?.workspacePath, resetEntries])

  useEffect(() => {
    void load()
  }, [load])

  const rootPath = (project?.workspacePath ?? '').trim()
  const rootEntries = rootPath ? entriesByPath[rootPath] : undefined

  const renderFile = useCallback(
    (file: FileEntryDto) => {
      return (
        <FileItem
          key={file.fullPath}
          onContextMenu={(e) =>
            openFsMenu(e, { kind: 'file', name: file.name, fullPath: file.fullPath })
          }
        >
          {file.name}
        </FileItem>
      )
    },
    [openFsMenu],
  )

  const renderDirectory = useCallback(
    (dir: DirectoryEntryDto) => {
      const children = entriesByPath[dir.fullPath]
      const nodeLoading = Boolean(nodeLoadingByPath[dir.fullPath])
      const nodeError = nodeErrorByPath[dir.fullPath]

      return (
        <FolderItem key={dir.fullPath} value={dir.fullPath}>
          <FolderTrigger
            onClick={(e) => {
              e.stopPropagation()
              void ensureEntries(dir.fullPath)
            }}
            onContextMenu={(e) =>
              openFsMenu(e, { kind: 'directory', name: dir.name, fullPath: dir.fullPath })
            }
          >
            {dir.name}
          </FolderTrigger>

          <FolderContent>
            {nodeError ? (
              <div className="px-2 py-2 text-sm text-destructive">{nodeError}</div>
            ) : null}

            {nodeLoading ? (
              <div className="px-2 py-2 text-sm text-muted-foreground">加载中…</div>
            ) : null}

            {!nodeLoading && children ? (
              <div className="space-y-1">
                {children.directories.length || children.files.length ? null : (
                  <div className="px-2 py-2 text-sm text-muted-foreground">暂无内容</div>
                )}

                {children.directories.length ? (
                  <SubFiles>{children.directories.map(renderDirectory)}</SubFiles>
                ) : null}

                {children.files.length ? (
                  <div className="px-2">{children.files.map(renderFile)}</div>
                ) : null}
              </div>
            ) : null}
          </FolderContent>
        </FolderItem>
      )
    },
    [ensureEntries, entriesByPath, nodeErrorByPath, nodeLoadingByPath, openFsMenu, renderFile],
  )

  const rootFilesView = useMemo(() => {
    if (!project) return null

    if (!rootPath) {
      return <div className="px-4 py-6 text-sm text-muted-foreground">未设置工作空间</div>
    }

    const nodeLoading = Boolean(nodeLoadingByPath[rootPath])
    const nodeError = nodeErrorByPath[rootPath]
    if (nodeError) {
      return <div className="px-4 py-6 text-sm text-destructive">{nodeError}</div>
    }

    if (nodeLoading || !rootEntries) {
      return <div className="px-4 py-6 text-sm text-muted-foreground">加载中…</div>
    }

    if (!rootEntries.directories.length && !rootEntries.files.length) {
      return <div className="px-4 py-6 text-sm text-muted-foreground">暂无文件</div>
    }

    return (
      <Files className="h-full">
        {rootEntries.directories.map(renderDirectory)}
        {rootEntries.files.map(renderFile)}
      </Files>
    )
  }, [
    project,
    renderDirectory,
    renderFile,
    rootEntries,
    rootPath,
    nodeErrorByPath,
    nodeLoadingByPath,
  ])

  return (
    <div className="h-full min-h-0 overflow-hidden flex flex-col">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold">
            {project?.name ?? (loading ? '加载中…' : '项目')}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {project?.workspacePath ?? (loading ? '正在获取项目详情…' : '')}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" onClick={() => window.history.back()}>
            返回
          </Button>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            刷新
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden flex gap-4">
        <aside className="w-1/4 min-w-[260px] shrink-0 overflow-hidden rounded-lg border bg-card flex flex-col">
          {fsNotice ? (
            <div className="p-2">
              <Alert className="py-2">
                <AlertDescription>{fsNotice}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          <div
            className="min-h-0 flex-1 overflow-hidden"
            onContextMenu={(e) => {
              if (!rootPath) return
              openFsMenu(e, {
                kind: 'directory',
                name: getBaseName(rootPath),
                fullPath: rootPath,
              })
            }}
          >
            {rootFilesView}
          </div>
        </aside>

        {project ? (
          <ProjectChatAndDetails key={project.id} project={project} />
        ) : (
          <section className="min-w-0 flex-1 overflow-hidden rounded-lg border bg-card flex flex-col">
            <div className="min-h-0 flex-1 overflow-hidden p-4 text-sm text-muted-foreground">
              {loading ? '加载中…' : '未找到项目。'}
            </div>
          </section>
        )}
      </div>

      <FsContextMenu
        open={Boolean(fsMenu)}
        x={fsMenu?.x ?? 0}
        y={fsMenu?.y ?? 0}
        onClose={closeFsMenu}
      >
        <div className="p-1">
          <div className="px-2 py-1 text-xs text-muted-foreground truncate">
            {fsMenu?.target.name}
          </div>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleRevealInExplorer(target.fullPath)
            }}
          >
            {fsMenu?.target.kind === 'directory'
              ? '在资源管理器中打开'
              : '在资源管理器中显示'}
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleOpenTerminal(target.fullPath)
            }}
          >
            在终端打开
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCopyPath(target.fullPath)
            }}
          >
            复制绝对路径
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCopyRelativePath(target.fullPath)
            }}
          >
            复制相对路径
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCopyName(target.name)
            }}
          >
            {fsMenu?.target.kind === 'directory' ? '复制文件夹名' : '复制文件名'}
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void createEntryAndRename('file', target)
            }}
          >
            新建文件
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void createEntryAndRename('directory', target)
            }}
          >
            新建文件夹
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              beginRename(target)
            }}
          >
            重命名
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              beginDelete(target)
            }}
          >
            删除
          </button>
        </div>
      </FsContextMenu>

      <Modal
        open={Boolean(renameTarget)}
        title={renameTarget?.kind === 'directory' ? '重命名文件夹' : '重命名文件'}
        onClose={() => {
          if (renameBusy) return
          setRenameTarget(null)
          setRenameDraft('')
          setRenameError(null)
        }}
      >
        <div className="space-y-3">
          {renameTarget ? (
            <div className="text-xs text-muted-foreground break-all">{renameTarget.fullPath}</div>
          ) : null}
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
              onClick={() => {
                if (renameBusy) return
                setRenameTarget(null)
                setRenameDraft('')
                setRenameError(null)
              }}
              disabled={renameBusy}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void submitRename()}
              disabled={renameBusy || !renameDraft.trim()}
            >
              确定
            </Button>
          </div>
        </div>
      </Modal>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (open) return
          if (deleteBusy) return
          setDeleteTarget(null)
          setDeleteError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除{deleteTarget?.kind === 'directory' ? '文件夹' : '文件'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除 “{deleteTarget?.name}” 吗？该操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget ? (
            <div className="text-xs text-muted-foreground break-all">{deleteTarget.fullPath}</div>
          ) : null}
          {deleteError ? <div className="text-sm text-destructive">{deleteError}</div> : null}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteBusy}
              onClick={() => {
                if (deleteBusy) return
                setDeleteTarget(null)
                setDeleteError(null)
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void confirmDelete()}
            >
              删除
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
