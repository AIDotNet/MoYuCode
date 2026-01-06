import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/api/client'
import type { GitLogResponse, GitStatusEntryDto, GitStatusResponse } from '@/api/types'
import { cn } from '@/lib/utils'
import { getVscodeFileIconUrl } from '@/lib/vscodeFileIcons'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ChevronDown, GitCommit, Minus, MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { GitGraph } from './GitGraph'

function getBaseName(fullPath: string): string {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return normalized
  const base = normalized.slice(lastSeparator + 1)
  return base || normalized
}

type GitFileKind = 'staged' | 'changes'

export type GitFile = {
  path: string
  originalPath: string | null
  indexStatus: string
  worktreeStatus: string
  kind: GitFileKind
}

export type GitState = {
  repoRoot: string
  branch: string | null
  staged: GitFile[]
  changes: GitFile[]
}

function normalizeStatusChar(value: string | null | undefined): string {
  return (value ?? '').trim() || ' '
}

function getStatusLabel(statusChar: string): string {
  const normalized = normalizeStatusChar(statusChar)
  if (normalized === '?') return 'U'
  if (normalized === ' ') return '·'
  return normalized
}

function getStatusBadgeClass(label: string): string {
  switch (label) {
    case 'M':
      return 'bg-sky-500/15 text-sky-300 ring-sky-500/30'
    case 'A':
      return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
    case 'D':
      return 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
    case 'R':
    case 'C':
      return 'bg-amber-500/15 text-amber-200 ring-amber-500/30'
    case 'U':
      return 'bg-muted/40 text-muted-foreground ring-border/60'
    default:
      return 'bg-muted/40 text-muted-foreground ring-border/60'
  }
}

function getFileLabel(file: Pick<GitFile, 'path' | 'originalPath'>): string {
  return file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
}

function getFileKey(file: Pick<GitFile, 'kind' | 'path' | 'indexStatus' | 'worktreeStatus'>): string {
  return `${file.kind}:${file.indexStatus}${file.worktreeStatus}:${file.path}`
}

function buildGitState(status: GitStatusResponse | null, log: GitLogResponse | null): GitState {
  const entries = status?.entries ?? []
  const repoRoot = status?.repoRoot ?? log?.repoRoot ?? ''
  const branch = status?.branch ?? log?.branch ?? null

  const staged: GitFile[] = []
  const changes: GitFile[] = []

  for (const entry of entries) {
    const indexStatus = normalizeStatusChar(entry.indexStatus)
    const worktreeStatus = normalizeStatusChar(entry.worktreeStatus)

    const base = {
      path: entry.path,
      originalPath: entry.originalPath,
      indexStatus,
      worktreeStatus,
    }

    const hasStaged = indexStatus !== ' ' && indexStatus !== '?'
    const hasChanges = worktreeStatus !== ' '

    if (hasStaged) staged.push({ ...base, kind: 'staged' })
    if (hasChanges) changes.push({ ...base, kind: 'changes' })
  }

  staged.sort((a, b) => a.path.localeCompare(b.path))
  changes.sort((a, b) => a.path.localeCompare(b.path))

  return { repoRoot, branch, staged, changes }
}

type GitDiffSnippet = { file: string; diff: string; truncated: boolean }

const aiDiffMaxChars = 4000
const aiDiffSkipNames = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
])

function scoreFileForAi(filePath: string): number {
  const base = getBaseName(filePath).toLowerCase()
  if (aiDiffSkipNames.has(base)) return 0

  const ext = base.includes('.') ? base.split('.').pop() ?? '' : ''
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'cs':
    case 'csproj':
    case 'json':
    case 'yml':
    case 'yaml':
    case 'toml':
      return 3
    case 'md':
    case 'txt':
      return 2
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'ico':
    case 'mp4':
    case 'mov':
    case 'mp3':
      return 0
    default:
      return 1
  }
}

function extractDiffHunks(diff: string): string {
  const lines = (diff ?? '').split('\n')
  const kept: string[] = []
  let inHunk = false

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      kept.push(line)
      continue
    }

    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      kept.push(line)
      continue
    }

    if (line.startsWith('@@')) {
      inHunk = true
      kept.push(line)
      continue
    }

    if (!inHunk) continue

    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')) {
      kept.push(line)
    }
  }

  return kept.join('\n').trim()
}

function buildAiDiffContext(snippets: GitDiffSnippet[], maxChars: number): { context: string; truncated: boolean } {
  const candidates = snippets
    .map((s) => {
      const score = scoreFileForAi(s.file)
      return { ...s, score }
    })
    .filter((s) => s.score > 0 && s.diff.trim())
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))

  const parts: string[] = []
  let used = 0
  let truncated = false

  for (const item of candidates) {
    const header = `# ${item.file}\n`
    const body = extractDiffHunks(item.diff)
    if (!body) continue

    const chunk = header + body + '\n\n'
    if (used + chunk.length <= maxChars) {
      parts.push(chunk)
      used += chunk.length
      continue
    }

    const remaining = maxChars - used
    if (remaining <= header.length + 40) {
      truncated = true
      break
    }

    const sliced = chunk.slice(0, Math.max(0, remaining - 18)).trimEnd() + '\n…(truncated)…\n\n'
    parts.push(sliced)
    used += sliced.length
    truncated = true
    break
  }

  return { context: parts.join('').trim(), truncated }
}

function createId(prefix = 'id'): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return `${prefix}-${crypto.randomUUID()}`
    }
  } catch {
    // fall back
  }

  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

function summarizeGitOutput(output: string | null | undefined, fallback: string): string {
  const text = (output ?? '').trim()
  if (!text) return fallback
  const line = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  const normalized = line.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  if (normalized.length <= 140) return normalized
  return normalized.slice(0, 139) + '…'
}

async function* readSseText(response: Response, signal?: AbortSignal): AsyncGenerator<string, void, unknown> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let dataLines: string[] = []

  while (true) {
    if (signal?.aborted) return
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const rawLine = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)

      const line = rawLine.replace(/\r$/, '').replace(/^\uFEFF/, '')
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

function readPartsText(parts: unknown): string {
  if (!Array.isArray(parts) || parts.length === 0) return ''
  const chunks: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as { text?: unknown }
    if (typeof p.text === 'string' && p.text) chunks.push(p.text)
  }
  return chunks.join('')
}

function buildCommitPrompt(opts: { files: GitFile[]; staged: boolean; diffContext: string }): string {
  const fileList = opts.files
    .slice(0, 60)
    .map((f) => `- ${f.path}`)
    .join('\n')

  return [
    'Generate a Git commit message for the changes below.',
    '',
    'Rules:',
    '- Output ONLY the commit message text (no markdown, no quotes).',
    '- Prefer Conventional Commits: <type>: <subject>.',
    '- Subject is imperative mood, <= 72 chars.',
    '- If needed, add a blank line then a concise bullet list.',
    '',
    `Context: ${opts.staged ? 'staged changes' : 'working tree changes (not staged)'}.`,
    '',
    'Changed files:',
    fileList || '- (none)',
    '',
    'Diff hunks:',
    opts.diffContext,
    '',
  ].join('\n')
}

function updateEntry(
  entry: GitStatusEntryDto,
  updater: (entry: GitStatusEntryDto) => GitStatusEntryDto,
): GitStatusEntryDto {
  try {
    return updater(entry)
  } catch {
    return entry
  }
}

function updateStatusEntry(
  status: GitStatusResponse | null,
  filePath: string,
  updater: (entry: GitStatusEntryDto) => GitStatusEntryDto,
): GitStatusResponse | null {
  if (!status) return status
  const next = status.entries.map((entry) => (entry.path === filePath ? updateEntry(entry, updater) : entry))
  return { ...status, entries: next }
}

function applyOptimisticStage(status: GitStatusResponse | null, filePath: string): GitStatusResponse | null {
  return updateStatusEntry(status, filePath, (entry) => {
    const index = normalizeStatusChar(entry.indexStatus)
    const wt = normalizeStatusChar(entry.worktreeStatus)

    if (index === '?' && wt === '?') {
      return { ...entry, indexStatus: 'A', worktreeStatus: ' ' }
    }

    if (wt === ' ') return entry

    return {
      ...entry,
      indexStatus: wt,
      worktreeStatus: ' ',
    }
  })
}

function applyOptimisticUnstage(status: GitStatusResponse | null, filePath: string): GitStatusResponse | null {
  return updateStatusEntry(status, filePath, (entry) => {
    const index = normalizeStatusChar(entry.indexStatus)
    const wt = normalizeStatusChar(entry.worktreeStatus)

    if (index === 'A' && wt === ' ') {
      return { ...entry, indexStatus: '?', worktreeStatus: '?' }
    }

    if (index === ' ' || index === '?') return entry

    return {
      ...entry,
      indexStatus: ' ',
      worktreeStatus: index,
    }
  })
}

export function ProjectCommitPanel({
  workspacePath,
  projectId,
  onOpenDiff,
}: {
  workspacePath: string
  projectId?: string | null
  onOpenDiff?: (file: string, opts?: { staged?: boolean }) => void
}) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [log, setLog] = useState<GitLogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [message, setMessage] = useState('')
  const [commitBusy, setCommitBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const [syncBusy, setSyncBusy] = useState<'pull' | 'push' | null>(null)

  const [aiBusy, setAiBusy] = useState(false)
  const aiAbortRef = useRef<AbortController | null>(null)

  const syncBusyRef = useRef(syncBusy)
  useEffect(() => {
    syncBusyRef.current = syncBusy
  }, [syncBusy])

  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const pendingRef = useRef<Set<string>>(new Set())
  const hasPending = pending.size > 0

  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (typeof window === 'undefined') return

    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null)
      noticeTimerRef.current = null
    }, 1800)
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
      if (aiAbortRef.current) aiAbortRef.current.abort()
    }
  }, [])

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const path = workspacePath.trim()
    if (!path) return

    const silent = Boolean(opts?.silent)
    if (!silent) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const [s, l] = await Promise.all([api.git.status(path), api.git.log(path, 200)])
      setStatus(s)
      setLog(l)
      setLoadError(null)
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const gitState = useMemo(() => buildGitState(status, log), [log, status])
  const hasStagedChanges = gitState.staged.length > 0

  const commit = useCallback(async () => {
    const path = workspacePath.trim()
    const msg = message.trim()
    if (!path || !msg || commitBusy) return

    setCommitBusy(true)
    setCommitError(null)
    try {
      await api.git.commit({ path, message: msg })
      setMessage('')
      await refresh()
    } catch (e) {
      setCommitError((e as Error).message)
    } finally {
      setCommitBusy(false)
    }
  }, [commitBusy, message, refresh, workspacePath])

  const stageFile = useCallback(
    async (file: GitFile) => {
      const path = workspacePath.trim()
      if (!path) return

      const stageKey = `stage:${file.path}`
      const unstageKey = `unstage:${file.path}`
      if (pendingRef.current.has(stageKey) || pendingRef.current.has(unstageKey)) return

      pendingRef.current.add(stageKey)
      setPending(new Set(pendingRef.current))

      setStatus((prev) => applyOptimisticStage(prev, file.path))
      try {
        await api.git.stage({ path, file: file.path })
        void refresh({ silent: true })
      } catch (e) {
        showNotice((e as Error).message)
        void refresh({ silent: true })
      } finally {
        pendingRef.current.delete(stageKey)
        setPending(new Set(pendingRef.current))
      }
    },
    [refresh, showNotice, workspacePath],
  )

  const unstageFile = useCallback(
    async (file: GitFile) => {
      const path = workspacePath.trim()
      if (!path) return

      const stageKey = `stage:${file.path}`
      const unstageKey = `unstage:${file.path}`
      if (pendingRef.current.has(stageKey) || pendingRef.current.has(unstageKey)) return

      pendingRef.current.add(unstageKey)
      setPending(new Set(pendingRef.current))

      setStatus((prev) => applyOptimisticUnstage(prev, file.path))
      try {
        await api.git.unstage({ path, file: file.path })
        void refresh({ silent: true })
      } catch (e) {
        showNotice((e as Error).message)
        void refresh({ silent: true })
      } finally {
        pendingRef.current.delete(unstageKey)
        setPending(new Set(pendingRef.current))
      }
    },
    [refresh, showNotice, workspacePath],
  )

  const [sectionsOpen, setSectionsOpen] = useState<{ staged: boolean; changes: boolean }>(() => ({
    staged: true,
    changes: true,
  }))

  const gitActionsAnchorRef = useRef<HTMLButtonElement | null>(null)
  const gitActionsMenuRef = useRef<HTMLDivElement | null>(null)
  const [gitActionsOpen, setGitActionsOpen] = useState(false)
  const [gitActionsMounted, setGitActionsMounted] = useState(false)
  const [gitActionsPos, setGitActionsPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (gitActionsOpen) {
      setGitActionsMounted(true)
      return
    }

    if (!gitActionsMounted) return
    const t = window.setTimeout(() => setGitActionsMounted(false), 150)
    return () => window.clearTimeout(t)
  }, [gitActionsMounted, gitActionsOpen])

  useEffect(() => {
    if (!gitActionsOpen) return

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) return

      const menu = gitActionsMenuRef.current
      if (menu && menu.contains(target)) return

      const anchor = gitActionsAnchorRef.current
      if (anchor && anchor.contains(target)) return

      setGitActionsOpen(false)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGitActionsOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [gitActionsOpen])

  useEffect(() => {
    if (!gitActionsOpen) return

    const anchor = gitActionsAnchorRef.current
    if (!anchor) return

    const update = () => {
      const rect = anchor.getBoundingClientRect()
      setGitActionsPos({ top: rect.bottom + 4, left: rect.right })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [gitActionsOpen])

  const runGitSync = useCallback(
    async (kind: 'pull' | 'push') => {
      const path = workspacePath.trim()
      if (!path) return
      if (syncBusyRef.current) return

      setSyncBusy(kind)
      setCommitError(null)

      try {
        const output =
          kind === 'pull' ? await api.git.pull({ path }) : await api.git.push({ path })
        showNotice(summarizeGitOutput(output, kind === 'pull' ? '拉取完成' : '推送完成'))
        void refresh({ silent: true })
      } catch (e) {
        showNotice((e as Error).message)
      } finally {
        setSyncBusy(null)
      }
    },
    [refresh, showNotice, workspacePath],
  )

  const handleGenerateCommit = useCallback(async () => {
    const path = workspacePath.trim()
    if (!path || aiBusy) return

    const source: { files: GitFile[]; staged: boolean } | null = gitState.staged.length
      ? { files: gitState.staged, staged: true }
      : gitState.changes.length
        ? { files: gitState.changes, staged: false }
        : null

    if (!source) {
      showNotice('没有可用于生成 Commit 的变更')
      return
    }

    setAiBusy(true)
    setCommitError(null)

    const controller = new AbortController()
    if (aiAbortRef.current) aiAbortRef.current.abort()
    aiAbortRef.current = controller

    try {
      const diffs = await Promise.all(
        source.files.map(async (file) => {
          const data = await api.git.diff(path, file.path, { staged: source.staged })
          return { file: file.path, diff: data.diff, truncated: data.truncated } satisfies GitDiffSnippet
        }),
      )

      const { context, truncated } = buildAiDiffContext(diffs, aiDiffMaxChars)
      if (!context) {
        showNotice('Diff 内容为空，无法生成 Commit Message')
        return
      }

      if (truncated) {
        showNotice('Diff 过长：已截取关键 Hunks 进行生成')
      }

      const prompt = buildCommitPrompt({ files: source.files, staged: source.staged, diffContext: context })

      const taskId = createId('task')
      const contextId = createId('ctx')
      const agentMessageId = `msg-agent-${taskId}`

      setMessage('')

      let assembled = ''

      const res = await fetch('/api/a2a', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: taskId,
          method: 'tasks/sendSubscribe',
          params: {
            taskId,
            contextId,
            ...(projectId ? { projectId } : { cwd: path }),
            message: {
              messageId: `msg-user-${taskId}`,
              parts: [{ text: prompt }],
            },
          },
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `${res.status} ${res.statusText}`)
      }

      for await (const payload of readSseText(res, controller.signal)) {
        if (controller.signal.aborted) return

        let envelope: unknown
        try {
          envelope = JSON.parse(payload) as unknown
        } catch {
          continue
        }

        if (!envelope || typeof envelope !== 'object') continue
        const envObj = envelope as { error?: unknown; result?: unknown }

        if (envObj.error && typeof envObj.error === 'object') {
          const msg = (envObj.error as { message?: unknown }).message
          throw new Error(typeof msg === 'string' && msg ? msg : 'AI request failed.')
        }

        const result = envObj.result as
          | {
              statusUpdate?: {
                final?: boolean
                status?: { message?: { messageId?: string; parts?: unknown } }
              }
            }
          | undefined

        const statusUpdate = result?.statusUpdate
        const msgId = statusUpdate?.status?.message?.messageId
        if (!msgId || msgId !== agentMessageId) continue

        const text = readPartsText(statusUpdate?.status?.message?.parts)
        if (!text) continue

        if (statusUpdate?.final) {
          assembled = text
          setMessage(text.trimEnd())
          continue
        }

        assembled += text
        setMessage(assembled)
      }

      if (!assembled.trim()) {
        showNotice('AI 未返回 Commit Message')
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        showNotice((e as Error).message)
      }
    } finally {
      if (!controller.signal.aborted) setAiBusy(false)
    }
  }, [aiBusy, gitState.changes, gitState.staged, projectId, showNotice, workspacePath])

  const logLines = useMemo(() => log?.lines ?? [], [log?.lines])
  const syncLocked = syncBusy !== null

  return (
    <div className="h-full min-h-0 overflow-hidden flex flex-col">
      <div className="p-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[11px] text-muted-foreground" title={gitState.repoRoot}>
              {gitState.branch ? ` ${gitState.branch}` : ' (detached)'}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              ref={gitActionsAnchorRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Git 操作"
              aria-haspopup="menu"
              aria-expanded={gitActionsOpen}
              aria-controls={gitActionsMounted ? 'git-actions-menu' : undefined}
              disabled={loading || commitBusy || aiBusy || syncLocked || hasPending}
              onClick={() => {
                setGitActionsOpen((open) => {
                  const next = !open
                  if (next) {
                    const anchor = gitActionsAnchorRef.current
                    if (anchor) {
                      const rect = anchor.getBoundingClientRect()
                      setGitActionsPos({ top: rect.bottom + 4, left: rect.right })
                    }
                  }
                  return next
                })
              }}
            >
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Git 操作</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="刷新"
              onClick={() => void refresh()}
              disabled={loading || commitBusy || syncLocked}
            >
              <RefreshCw className={cn('size-4', loading ? 'motion-safe:animate-spin' : '')} />
            </Button>
          </div>
        </div>

        <div className="relative">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            disabled={commitBusy || loading || aiBusy || syncLocked}
            className="min-h-20 pr-10 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void commit()
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute bottom-1.5 right-1.5"
            title={aiBusy ? 'Generating…' : 'AI 生成 Commit Message'}
            onClick={() => void handleGenerateCommit()}
            disabled={loading || commitBusy || aiBusy || syncLocked}
          >
            {aiBusy ? <Spinner className="size-4" /> : <span aria-hidden="true">✨</span>}
          </Button>
        </div>

        <Button
          type="button"
          className="w-full"
          disabled={
            !hasStagedChanges ||
            commitBusy ||
            loading ||
            aiBusy ||
            syncLocked ||
            hasPending ||
            !message.trim()
          }
          onClick={() => void commit()}
        >
          {commitBusy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner /> Commit…
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <GitCommit className="size-4" />
              Commit
            </span>
          )}
        </Button>

        {!hasStagedChanges ? (
          <div className="text-xs text-muted-foreground">暂存区为空：请先 Stage 需要提交的文件</div>
        ) : null}
        {notice ? <div className="text-xs text-muted-foreground">{notice}</div> : null}
        {commitError ? <div className="text-xs text-destructive">{commitError}</div> : null}
        {loadError ? <div className="text-xs text-destructive">{loadError}</div> : null}
      </div>

      {typeof document !== 'undefined' && gitActionsMounted && gitActionsPos
        ? createPortal(
            <div
              id="git-actions-menu"
              ref={gitActionsMenuRef}
              role="menu"
              data-state={gitActionsOpen ? 'open' : 'closed'}
              className={cn(
                'fixed z-50 w-36 origin-top-right -translate-x-full rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
                'data-[state=open]:animate-in data-[state=closed]:animate-out',
                'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
                'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
                'duration-150',
                !gitActionsOpen && 'pointer-events-none',
              )}
              style={{ top: gitActionsPos.top, left: gitActionsPos.left }}
            >
              <button
                type="button"
                role="menuitem"
                className={cn(
                  'flex w-full items-center rounded-sm px-2 py-1.5 text-sm',
                  'hover:bg-accent hover:text-accent-foreground',
                  syncLocked ? 'opacity-60 pointer-events-none' : '',
                )}
                onClick={() => {
                  setGitActionsOpen(false)
                  void runGitSync('pull')
                }}
              >
                {syncBusy === 'pull' ? '拉取中…' : '拉取'}
              </button>
              <button
                type="button"
                role="menuitem"
                className={cn(
                  'flex w-full items-center rounded-sm px-2 py-1.5 text-sm',
                  'hover:bg-accent hover:text-accent-foreground',
                  syncLocked ? 'opacity-60 pointer-events-none' : '',
                )}
                onClick={() => {
                  setGitActionsOpen(false)
                  void runGitSync('push')
                }}
              >
                {syncBusy === 'push' ? '推送中…' : '推送'}
              </button>
            </div>,
            document.body,
          )
        : null}

      <div className="min-h-0 flex-1 overflow-hidden flex flex-col border-t">
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {loading ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Spinner /> 加载中…
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border bg-card">
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left',
                    'text-xs font-medium text-muted-foreground hover:bg-accent/40',
                  )}
                  onClick={() => setSectionsOpen((s) => ({ ...s, staged: !s.staged }))}
                >
                  <span className="inline-flex items-center gap-2">
                    <ChevronDown className={cn('size-4 transition-transform', sectionsOpen.staged ? '' : '-rotate-90')} />
                    Staged Changes
                  </span>
                  <span className="rounded-sm bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {gitState.staged.length}
                  </span>
                </button>
                {sectionsOpen.staged ? (
                  <div className="p-1">
                    {gitState.staged.length ? (
                      <div className="space-y-1">
                        {gitState.staged.map((file) => {
                          const label = getStatusLabel(file.indexStatus)
                          const iconUrl = getVscodeFileIconUrl(getBaseName(file.path))
                          return (
                            <div
                              key={getFileKey(file)}
                              role="button"
                              tabIndex={0}
                              className={cn(
                                'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                                'transition-colors hover:bg-accent/40',
                              )}
                              onClick={() => onOpenDiff?.(file.path, { staged: true })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') onOpenDiff?.(file.path, { staged: true })
                              }}
                              title={`index:${file.indexStatus} worktree:${file.worktreeStatus}`}
                            >
                              <span
                                className={cn(
                                  'inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold',
                                  'ring-1 ring-inset',
                                  getStatusBadgeClass(label),
                                )}
                              >
                                {label}
                              </span>
                              {iconUrl ? (
                                <img
                                  src={iconUrl}
                                  alt=""
                                  aria-hidden="true"
                                  draggable={false}
                                  className="size-4.5 shrink-0"
                                />
                              ) : null}
                              <span className="min-w-0 flex-1 truncate text-xs">{getFileLabel(file)}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void unstageFile(file)
                                }}
                                title="Unstage"
                                disabled={
                                  commitBusy ||
                                  aiBusy ||
                                  syncLocked ||
                                  pending.has(`unstage:${file.path}`) ||
                                  pending.has(`stage:${file.path}`)
                                }
                              >
                                <Minus className="size-4" />
                                <span className="sr-only">Unstage</span>
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="px-2 py-2 text-xs text-muted-foreground">No staged changes</div>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="rounded-md border bg-card">
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left',
                    'text-xs font-medium text-muted-foreground hover:bg-accent/40',
                  )}
                  onClick={() => setSectionsOpen((s) => ({ ...s, changes: !s.changes }))}
                >
                  <span className="inline-flex items-center gap-2">
                    <ChevronDown className={cn('size-4 transition-transform', sectionsOpen.changes ? '' : '-rotate-90')} />
                    Changes
                  </span>
                  <span className="rounded-sm bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {gitState.changes.length}
                  </span>
                </button>
                {sectionsOpen.changes ? (
                  <div className="p-1">
                    {gitState.changes.length ? (
                      <div className="space-y-1">
                        {gitState.changes.map((file) => {
                          const label = getStatusLabel(file.worktreeStatus)
                          const iconUrl = getVscodeFileIconUrl(getBaseName(file.path))
                          return (
                            <div
                              key={getFileKey(file)}
                              role="button"
                              tabIndex={0}
                              className={cn(
                                'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                                'transition-colors hover:bg-accent/40',
                              )}
                              onClick={() => onOpenDiff?.(file.path, { staged: false })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') onOpenDiff?.(file.path, { staged: false })
                              }}
                              title={`index:${file.indexStatus} worktree:${file.worktreeStatus}`}
                            >
                              <span
                                className={cn(
                                  'inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold',
                                  'ring-1 ring-inset',
                                  getStatusBadgeClass(label),
                                )}
                              >
                                {label}
                              </span>
                              {iconUrl ? (
                                <img
                                  src={iconUrl}
                                  alt=""
                                  aria-hidden="true"
                                  draggable={false}
                                  className="size-4.5 shrink-0"
                                />
                              ) : null}
                              <span className="min-w-0 flex-1 truncate text-xs">{getFileLabel(file)}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void stageFile(file)
                                }}
                                title="Stage"
                                disabled={
                                  commitBusy ||
                                  aiBusy ||
                                  syncLocked ||
                                  pending.has(`stage:${file.path}`) ||
                                  pending.has(`unstage:${file.path}`)
                                }
                              >
                                <Plus className="size-4" />
                                <span className="sr-only">Stage</span>
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="px-2 py-2 text-xs text-muted-foreground">No changes</div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t px-2 py-2 max-h-[45%] overflow-auto">
          <GitGraph lines={logLines} />
        </div>
      </div>
    </div>
  )
}
