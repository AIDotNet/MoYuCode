import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/api/client'
import type { ProjectDto } from '@/api/types'
import type { CodeSelection, WorkspaceFileRef } from '@/lib/chatPromptXml'
import { buildUserPromptWithWorkspaceContext } from '@/lib/chatWorkspaceContextXml'
import { cn } from '@/lib/utils'
import { getVscodeFileIconUrl } from '@/lib/vscodeFileIcons'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/animate-ui/primitives/animate/tooltip'
import { ChevronDown, Eye, EyeOff, Image as ImageIcon, X } from 'lucide-react'

type ChatRole = 'user' | 'agent' | 'system'

type ChatMessageKind = 'text' | 'think' | 'tool'

type ChatImage = {
  id: string
  url: string
  fileName: string
  contentType: string
  sizeBytes: number
}

type ChatMessage = {
  id: string
  role: ChatRole
  kind: ChatMessageKind
  text: string
  images?: ChatImage[]
  toolName?: string
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

type TokenUsageSnapshot = {
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}

type TokenUsageArtifact = {
  total?: TokenUsageSnapshot
  last?: TokenUsageSnapshot
  modelContextWindow?: number
}

function getApiBase(): string {
  return (
    ''
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

function createUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    // fall back
  }

  try {
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    // v4
    buf[6] = (buf[6] & 0x0f) | 0x40
    buf[8] = (buf[8] & 0x3f) | 0x80
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    const seed = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
    const padded = seed.padEnd(32, '0').slice(0, 32)
    return `${padded.slice(0, 8)}-${padded.slice(8, 12)}-4${padded.slice(13, 16)}-a${padded.slice(17, 20)}-${padded.slice(20)}`
  }
}

type UploadedImageDto = {
  id: string
  url: string
  fileName: string
  contentType: string
  sizeBytes: number
}

type DraftImage = {
  clientId: string
  url: string
  localObjectUrl: string
  uploadedId: string | null
  fileName: string
  contentType: string
  sizeBytes: number
  status: 'uploading' | 'ready' | 'error'
  error: string | null
}

const maxDraftImages = 8
const maxDraftImageBytes = 10 * 1024 * 1024

async function uploadImage(
  apiBase: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadedImageDto> {
  const form = new FormData()
  form.append('file', file, file.name || 'image')

  const res = await fetch(`${apiBase}/api/media/images`, {
    method: 'POST',
    body: form,
    signal,
  })

  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    const msg =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message?: unknown }).message ?? '')
        : ''
    throw new Error(msg || `${res.status} ${res.statusText}`)
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Upload failed.')
  }

  const first = payload[0] as Partial<UploadedImageDto>
  const id = String(first.id ?? '').trim()
  const url = String(first.url ?? '').trim()
  const fileName = String(first.fileName ?? '').trim()
  const contentType = String(first.contentType ?? '').trim()
  const sizeBytes = Number(first.sizeBytes ?? 0)

  if (!id || !url) {
    throw new Error('Upload failed: missing image id/url.')
  }

  return { id, url, fileName, contentType, sizeBytes }
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

function truncateInlineText(value: string, maxChars = 140): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, Math.max(0, maxChars - 1)) + '…'
}

type MentionToken = {
  start: number
  end: number
  query: string
}

type MentionedFile = {
  fullPath: string
  relativePath: string
  baseName: string
  iconUrl: string | null
}

type WorkspaceFileIndex = {
  files: string[]
  truncated: boolean
}

const workspaceFileIndexSkipDirs = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.vs',
  'node_modules',
  'bin',
  'obj',
  'dist',
  '.next',
  '.vite',
  '.turbo',
  '.cache',
])

const workspaceFileIndexMaxFiles = 2500
const workspaceFileIndexMaxDirs = 5000

function normalizePathForComparison(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

function getBaseName(fullPath: string): string {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return normalized
  const base = normalized.slice(lastSeparator + 1)
  return base || normalized
}

function splitPathParts(path: string): string[] {
  return path.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
}

function tryGetWorkspaceRelativePath(workspacePath: string, fullPath: string): string | null {
  const rootParts = splitPathParts(workspacePath)
  const fileParts = splitPathParts(fullPath)

  if (!rootParts.length || !fileParts.length) return null
  if (rootParts.length > fileParts.length) return null

  for (let i = 0; i < rootParts.length; i += 1) {
    if (rootParts[i].toLowerCase() !== fileParts[i].toLowerCase()) return null
  }

  const relParts = fileParts.slice(rootParts.length)
  return relParts.length ? relParts.join('/') : null
}

function tryGetMentionToken(value: string, caret: number): MentionToken | null {
  const text = value ?? ''
  const pos = Math.max(0, Math.min(caret, text.length))
  const at = text.lastIndexOf('@', pos - 1)
  if (at < 0) return null
  if (at > 0) {
    const prev = text[at - 1]
    // Allow "@file" right after Chinese / punctuation, but avoid triggering inside emails.
    if (/[A-Za-z0-9._%+-]/.test(prev)) return null
  }

  const query = text.slice(at + 1, pos)
  if (/\s/.test(query)) return null
  return { start: at, end: pos, query }
}

async function indexWorkspaceFiles(workspacePath: string): Promise<WorkspaceFileIndex> {
  const root = workspacePath.trim()
  if (!root) return { files: [], truncated: false }

  const queue: string[] = [root]
  const visited = new Set<string>()
  const files: string[] = []
  let truncated = false

  while (queue.length) {
    const current = queue.shift()
    if (!current) break

    const visitKey = normalizePathForComparison(current)
    if (!visitKey) continue
    if (visited.has(visitKey)) continue
    visited.add(visitKey)

    if (visited.size > workspaceFileIndexMaxDirs) {
      truncated = true
      break
    }

    let entries
    try {
      entries = await api.fs.listEntries(current)
    } catch {
      continue
    }

    for (const f of entries.files) {
      files.push(f.fullPath)
      if (files.length >= workspaceFileIndexMaxFiles) {
        truncated = true
        break
      }
    }

    if (truncated) break

    for (const d of entries.directories) {
      if (workspaceFileIndexSkipDirs.has(d.name.toLowerCase())) continue
      queue.push(d.fullPath)
    }
  }

  files.sort((a, b) => a.localeCompare(b))
  return { files, truncated }
}

function stringifyToolArgs(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

type CodexToolCallInfo = {
  callId?: string
  toolName: string
  toolArgs: string
}

function tryExtractCodexToolCall(raw: string, method?: string): CodexToolCallInfo | null {
  const combined = `${method ?? ''}\n${raw}`.toLowerCase()
  const mightBeToolCall =
    combined.includes('function_call') ||
    combined.includes('custom_tool_call') ||
    combined.includes('tool_call') ||
    combined.includes('tooluse') ||
    combined.includes('tool_use') ||
    combined.includes('functioncall') ||
    combined.includes('toolcall') ||
    combined.includes('mcp')

  if (!mightBeToolCall) return null

  let ev: unknown
  try {
    ev = JSON.parse(raw)
  } catch {
    return null
  }

  if (!ev || typeof ev !== 'object') return null
  const evObj = ev as { params?: unknown }
  const params = evObj.params
  const candidates: unknown[] = []

  if (params && typeof params === 'object') {
    const p = params as Record<string, unknown>
    candidates.push(p.item, p.call, p.toolCall, p.tool_call, p.tool, p.msg, p)
  } else {
    candidates.push(params)
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const c = candidate as Record<string, unknown>
    const typeRaw = c.type ?? c.kind ?? c.item_type ?? c.itemType
    const type = typeof typeRaw === 'string' ? typeRaw.toLowerCase() : ''

    const isToolCallType =
      type === 'function_call' ||
      type === 'custom_tool_call' ||
      type === 'tool_call' ||
      type === 'tool_use' ||
      type === 'tooluse' ||
      type === 'mcptoolcall' ||
      type === 'mcp_tool_call' ||
      type === 'mcp-tool-call' ||
      type === 'mcp_tool_call_begin' ||
      type === 'mcp_tool_call_end'

    const hasNameish =
      typeof c.name === 'string' ||
      typeof c.toolName === 'string' ||
      typeof c.tool_name === 'string' ||
      typeof c.tool === 'string'

    if (!isToolCallType && !hasNameish) continue

    const invocation =
      c.invocation && typeof c.invocation === 'object'
        ? (c.invocation as Record<string, unknown>)
        : null

    const callId =
      (typeof c.call_id === 'string' ? c.call_id : undefined) ??
      (typeof c.callId === 'string' ? c.callId : undefined) ??
      (typeof c.id === 'string' ? c.id : undefined)

    const server =
      (typeof c.server === 'string' ? c.server : undefined) ??
      (invocation && typeof invocation.server === 'string' ? invocation.server : undefined)

    const toolNameBase =
      (typeof c.name === 'string' ? c.name : undefined) ??
      (typeof c.toolName === 'string' ? c.toolName : undefined) ??
      (typeof c.tool_name === 'string' ? c.tool_name : undefined) ??
      (typeof c.tool === 'string' ? c.tool : undefined) ??
      (invocation && typeof invocation.tool === 'string' ? invocation.tool : undefined) ??
      (typeof method === 'string' && method ? method : 'tool')

    const toolName = server && toolNameBase && !toolNameBase.startsWith(`${server}.`)
      ? `${server}.${toolNameBase}`
      : toolNameBase

    const argsValue =
      c.arguments ??
      c.args ??
      c.input ??
      c.parameters ??
      (invocation ? invocation.arguments : undefined) ??
      (typeof c.command === 'string' ? { command: c.command } : undefined)

    const toolArgs = stringifyToolArgs(argsValue)
    return { callId, toolName, toolArgs }
  }

  return null
}

function safeNumber(value: number | null | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0
}

function formatNumber(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return '—'
  return (value as number).toLocaleString()
}

function formatCompactNumber(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return '—'

  const abs = Math.abs(value as number)
  if (abs < 1000) return (value as number).toLocaleString()

  try {
    const fmt = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: 1,
    })
    return fmt.format(value as number)
  } catch {
    const sign = (value as number) < 0 ? '-' : ''

    const stripTrailingZero = (raw: string) => (raw.endsWith('.0') ? raw.slice(0, -2) : raw)

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

function toTokenUsageSnapshot(value: unknown): TokenUsageSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>

  const snap: TokenUsageSnapshot = {
    totalTokens: typeof obj.totalTokens === 'number' ? obj.totalTokens : undefined,
    inputTokens: typeof obj.inputTokens === 'number' ? obj.inputTokens : undefined,
    cachedInputTokens:
      typeof obj.cachedInputTokens === 'number' ? obj.cachedInputTokens : undefined,
    outputTokens: typeof obj.outputTokens === 'number' ? obj.outputTokens : undefined,
    reasoningOutputTokens:
      typeof obj.reasoningOutputTokens === 'number' ? obj.reasoningOutputTokens : undefined,
  }

  const hasAny =
    Number.isFinite(snap.totalTokens) ||
    Number.isFinite(snap.inputTokens) ||
    Number.isFinite(snap.cachedInputTokens) ||
    Number.isFinite(snap.outputTokens) ||
    Number.isFinite(snap.reasoningOutputTokens)

  return hasAny ? snap : null
}

function normalizeTokenUsageArtifact(value: unknown): TokenUsageArtifact | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>

  const hasEnvelopeKeys =
    'total' in obj || 'last' in obj || 'modelContextWindow' in obj || 'contextWindow' in obj

  if (!hasEnvelopeKeys) {
    const last = toTokenUsageSnapshot(value)
    return last ? { last } : null
  }

  const total = toTokenUsageSnapshot(obj.total)
  const last = toTokenUsageSnapshot(obj.last)

  const contextCandidate = obj.modelContextWindow ?? obj.contextWindow
  const modelContextWindow =
    typeof contextCandidate === 'number' ? contextCandidate : undefined

  if (!total && !last && !Number.isFinite(modelContextWindow)) return null

  return {
    ...(total ? { total } : {}),
    ...(last ? { last } : {}),
    ...(Number.isFinite(modelContextWindow) ? { modelContextWindow } : {}),
  }
}

function getSnapshotTotal(snapshot: TokenUsageSnapshot | undefined): number | null {
  if (!snapshot) return null
  if (Number.isFinite(snapshot.totalTokens)) return snapshot.totalTokens as number

  if (Number.isFinite(snapshot.inputTokens) && Number.isFinite(snapshot.outputTokens)) {
    return safeNumber(snapshot.inputTokens) + safeNumber(snapshot.outputTokens)
  }

  if (Number.isFinite(snapshot.inputTokens)) return snapshot.inputTokens as number
  if (Number.isFinite(snapshot.outputTokens)) return snapshot.outputTokens as number
  return null
}

function TokenUsagePill({ usage }: { usage: TokenUsageArtifact }) {
  const lastTotal = getSnapshotTotal(usage.last ?? undefined)
  const totalTotal = getSnapshotTotal(usage.total ?? undefined)

  const displayTotal = lastTotal ?? totalTotal
  const displayCompact = formatCompactNumber(displayTotal)

  return (
    <Tooltip side="top" sideOffset={8} align="start">
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex cursor-default select-none items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground',
            'hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <span className="text-muted-foreground">Token</span>
          <span className="text-foreground/90">{displayCompact}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        className={cn(
          'pointer-events-none max-w-[22rem] rounded-md border border-border/60 bg-popover/95 px-2 py-1.5 text-[11px] text-popover-foreground shadow-lg backdrop-blur-sm',
        )}
      >
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-6">
            <span className="text-muted-foreground">本次</span>
            <span className="font-medium">{formatNumber(lastTotal ?? undefined)}</span>
          </div>

          {Number.isFinite(totalTotal) ? (
            <div className="flex items-center justify-between gap-6">
              <span className="text-muted-foreground">累计</span>
              <span>{formatNumber(totalTotal ?? undefined)}</span>
            </div>
          ) : null}

          {Number.isFinite(usage.modelContextWindow) ? (
            <div className="flex items-center justify-between gap-6">
              <span className="text-muted-foreground">上下文窗口</span>
              <span>{formatNumber(usage.modelContextWindow ?? undefined)}</span>
            </div>
          ) : null}

          <div className="my-1 h-px bg-border/60" />

          <div className="flex items-center justify-between gap-6">
            <span className="text-muted-foreground">输入</span>
            <span>{formatNumber(usage.last?.inputTokens ?? undefined)}</span>
          </div>
          {Number.isFinite(usage.last?.cachedInputTokens) ? (
            <div className="flex items-center justify-between gap-6">
              <span className="text-muted-foreground">缓存输入</span>
              <span>{formatNumber(usage.last?.cachedInputTokens ?? undefined)}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-6">
            <span className="text-muted-foreground">输出</span>
            <span>{formatNumber(usage.last?.outputTokens ?? undefined)}</span>
          </div>
          {Number.isFinite(usage.last?.reasoningOutputTokens) ? (
            <div className="flex items-center justify-between gap-6">
              <span className="text-muted-foreground">思考输出</span>
              <span>{formatNumber(usage.last?.reasoningOutputTokens ?? undefined)}</span>
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

type ChatAlign = 'justify-end' | 'justify-start'

type OpenById = Record<string, boolean>
type SetOpenById = Dispatch<SetStateAction<OpenById>>

function ChatMessageRow({ align, children }: { align: ChatAlign; children: ReactNode }) {
  return <div className={cn('mx-auto flex w-full max-w-3xl py-1', align)}>{children}</div>
}

const ChatMessageImages = memo(function ChatMessageImages({ images }: { images: ChatImage[] }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {images.map((img) => (
        <a
          key={img.id}
          href={img.url}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'block overflow-hidden rounded-md border bg-background/30',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
          )}
          title={img.fileName || 'image'}
        >
          <img
            src={img.url}
            alt={img.fileName || ''}
            className="block h-auto w-full max-h-[260px] object-contain"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  )
})

const ChatThinkMessage = memo(function ChatThinkMessage({
  message,
  align,
  open,
  isActive,
  onToggle,
}: {
  message: ChatMessage
  align: ChatAlign
  open: boolean
  isActive: boolean
  onToggle: (id: string, defaultOpen: boolean) => void
}) {
  return (
    <ChatMessageRow align={align}>
      <div className="max-w-[80%] overflow-hidden rounded-lg border bg-muted/30 text-foreground">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            '!h-auto w-full items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground',
            'hover:bg-accent/40',
            '!rounded-none',
          )}
          aria-expanded={open}
          aria-controls={`think-${message.id}`}
          onClick={() => onToggle(message.id, isActive)}
        >
          <span className="inline-flex items-center gap-2">
            <span>思考</span>
            {isActive ? (
              <span className="inline-flex items-center gap-1">
                <Spinner className="size-3" />
                <span>生成中</span>
              </span>
            ) : null}
          </span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 transition-transform',
              open ? 'rotate-0' : '-rotate-90',
            )}
          />
        </Button>

        {open ? (
          <pre
            id={`think-${message.id}`}
            className="px-3 pb-3 text-xs whitespace-pre-wrap break-words"
          >
            {message.text}
          </pre>
        ) : null}
      </div>
    </ChatMessageRow>
  )
})

const ChatToolMessage = memo(function ChatToolMessage({
  message,
  align,
  open,
  onToggle,
}: {
  message: ChatMessage
  align: ChatAlign
  open: boolean
  onToggle: (id: string) => void
}) {
  const toolName = message.toolName ?? 'tool'
  const argsPreview = message.text ? truncateInlineText(message.text, 120) : ''

  return (
    <ChatMessageRow align={align}>
      <div className="max-w-[80%] overflow-hidden rounded-lg border bg-muted/30 text-foreground">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            '!h-auto w-full items-start justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground',
            'hover:bg-accent/40',
            '!rounded-none',
          )}
          aria-expanded={open}
          aria-controls={`tool-${message.id}`}
          onClick={() => onToggle(message.id)}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">{toolName}</span>
            {argsPreview ? (
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {argsPreview}
              </span>
            ) : null}
          </span>
          <ChevronDown
            className={cn(
              'mt-0.5 size-4 shrink-0 transition-transform',
              open ? 'rotate-0' : '-rotate-90',
            )}
          />
        </Button>

        {open ? (
          <pre
            id={`tool-${message.id}`}
            className="px-3 pb-3 text-xs whitespace-pre-wrap break-words"
          >
            {message.text}
          </pre>
        ) : null}
      </div>
    </ChatMessageRow>
  )
})

const ChatTextMessage = memo(function ChatTextMessage({
  message,
  align,
  isActiveAgentMessage,
  tokenUsage,
}: {
  message: ChatMessage
  align: ChatAlign
  isActiveAgentMessage: boolean
  tokenUsage?: TokenUsageArtifact
}) {
  const showBubble = Boolean(message.text) || (message.role === 'agent' && isActiveAgentMessage)

  return (
    <ChatMessageRow align={align}>
      <div className="max-w-[80%]">
        {showBubble ? (
          <div
            className={cn(
              'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
              message.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : message.role === 'agent'
                  ? 'bg-muted text-foreground'
                  : 'bg-accent text-accent-foreground',
            )}
          >
            {message.text ? (
              message.text
            ) : message.role === 'agent' && isActiveAgentMessage ? (
              <span className="inline-flex items-center">
                <Spinner />
              </span>
            ) : null}
          </div>
        ) : null}

        {message.images?.length ? <ChatMessageImages images={message.images} /> : null}

        {tokenUsage ? (
          <div className={cn('mt-1', align === 'justify-end' ? 'text-right' : '')}>
            <TokenUsagePill usage={tokenUsage} />
          </div>
        ) : null}
      </div>
    </ChatMessageRow>
  )
})

const ChatMessageList = memo(function ChatMessageList({
  messages,
  sending,
  activeTaskId,
  activeReasoningMessageId,
  thinkOpenById,
  setThinkOpenById,
  toolOpenById,
  setToolOpenById,
  tokenByMessageId,
}: {
  messages: ChatMessage[]
  sending: boolean
  activeTaskId: string | null
  activeReasoningMessageId: string | null
  thinkOpenById: OpenById
  setThinkOpenById: SetOpenById
  toolOpenById: OpenById
  setToolOpenById: SetOpenById
  tokenByMessageId: Record<string, TokenUsageArtifact>
}) {
  const toggleThinkOpen = useCallback(
    (id: string, defaultOpen: boolean) => {
      setThinkOpenById((prev) => ({
        ...prev,
        [id]: !(prev[id] ?? defaultOpen),
      }))
    },
    [setThinkOpenById],
  )

  const toggleToolOpen = useCallback(
    (id: string) => {
      setToolOpenById((prev) => ({
        ...prev,
        [id]: !(prev[id] ?? false),
      }))
    },
    [setToolOpenById],
  )

  return (
    <div className="space-y-2">
      {messages.map((m) => {
        const align: ChatAlign = m.role === 'user' ? 'justify-end' : 'justify-start'
        const isActiveAgentMessage =
          Boolean(sending && activeTaskId) && m.id === `msg-agent-${activeTaskId}`
        const isActiveThinkMessage =
          Boolean(sending && activeTaskId && activeReasoningMessageId) &&
          m.kind === 'think' &&
          m.id === activeReasoningMessageId

        if (m.kind === 'think') {
          const open = thinkOpenById[m.id] ?? isActiveThinkMessage
          return (
            <ChatThinkMessage
              key={m.id}
              message={m}
              align={align}
              open={open}
              isActive={isActiveThinkMessage}
              onToggle={toggleThinkOpen}
            />
          )
        }

        if (m.kind === 'tool') {
          const open = toolOpenById[m.id] ?? false
          return (
            <ChatToolMessage
              key={m.id}
              message={m}
              align={align}
              open={open}
              onToggle={toggleToolOpen}
            />
          )
        }

        const tokenUsage = m.role === 'agent' ? tokenByMessageId[m.id] : undefined
        return (
          <ChatTextMessage
            key={m.id}
            message={m}
            align={align}
            isActiveAgentMessage={isActiveAgentMessage}
            tokenUsage={tokenUsage}
          />
        )
      })}
    </div>
  )
})

function upsertThinkChunk(
  prev: ChatMessage[],
  thinkMessageId: string,
  agentMessageId: string,
  chunk: string,
): ChatMessage[] {
  const existingIndex = prev.findIndex((m) => m.id === thinkMessageId)
  if (existingIndex >= 0) {
    const next = [...prev]
    const existing = next[existingIndex]
    next[existingIndex] = { ...existing, text: existing.text + chunk }
    return next
  }

  const insertIndex = prev.findIndex((m) => m.id === agentMessageId)
  const next = [...prev]
  const message: ChatMessage = { id: thinkMessageId, role: 'agent', kind: 'think', text: chunk }
  if (insertIndex >= 0) {
    next.splice(insertIndex, 0, message)
  } else {
    next.push(message)
  }
  return next
}

function insertBeforeMessage(
  prev: ChatMessage[],
  anchorMessageId: string,
  message: ChatMessage,
): ChatMessage[] {
  const insertIndex = prev.findIndex((m) => m.id === anchorMessageId)
  const next = [...prev]
  if (insertIndex >= 0) {
    next.splice(insertIndex, 0, message)
  } else {
    next.push(message)
  }
  return next
}

export function ProjectChat({
  project,
  detailsOpen,
  detailsPortalTarget,
  activeFilePath,
  codeSelection,
  onClearCodeSelection,
  onToolOutput,
}: {
  project: ProjectDto
  detailsOpen: boolean
  detailsPortalTarget: HTMLDivElement | null
  activeFilePath?: string | null
  codeSelection?: CodeSelection | null
  onClearCodeSelection?: () => void
  onToolOutput?: (chunk: string) => void
}) {
  const apiBase = useMemo(() => getApiBase(), [])
  const sessionIdRef = useRef<string>(createUuid())
  const workspacePath = project.workspacePath.trim()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<DraftImage[]>([])
  const [sending, setSending] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [activeReasoningMessageId, setActiveReasoningMessageId] = useState<string | null>(
    null,
  )
  const [canceling, setCanceling] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [toolOutput, setToolOutput] = useState('')
  const [modelOverride, setModelOverride] = useState('')
  const [providerModelOptions, setProviderModelOptions] = useState<string[]>([])
  const [providerModelsLoaded, setProviderModelsLoaded] = useState(false)
  const [customModels, setCustomModels] = useState<string[]>([])
  const [customModelsLoaded, setCustomModelsLoaded] = useState(false)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [addModelDraft, setAddModelDraft] = useState('')
  const [addModelError, setAddModelError] = useState<string | null>(null)

  const [mentionToken, setMentionToken] = useState<MentionToken | null>(null)
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([])
  const [includeActiveFileInPrompt, setIncludeActiveFileInPrompt] = useState(true)

  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([])
  const [workspaceFilesTruncated, setWorkspaceFilesTruncated] = useState(false)
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false)
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null)
  const workspaceFilesCacheRef = useRef<{
    workspacePath: string
    files: string[]
    truncated: boolean
  } | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const draftImagesRef = useRef<DraftImage[]>([])

  const [thinkOpenById, setThinkOpenById] = useState<Record<string, boolean>>({})
  const [toolOpenById, setToolOpenById] = useState<Record<string, boolean>>({})
  const [tokenByMessageId, setTokenByMessageId] = useState<Record<string, TokenUsageArtifact>>(
    {},
  )

  const [rawEvents, setRawEvents] = useState<CodexEventLogItem[]>([])
  const addModelSentinel = '__onecode_add_model__'
  const modelDefaultSentinel = '__onecode_model_default__'

  const customModelStorageKey = useMemo(() => {
    const providerKey = project.providerId ? project.providerId : 'default'
    return `onecode:chat:custom-models:v1:${project.toolType}:${providerKey}`
  }, [project.providerId, project.toolType])

  const modelOverrideStorageKey = useMemo(() => {
    return `onecode:chat:model-override:v1:${project.id}`
  }, [project.id])

  const availableModels = useMemo(() => {
    const seen = new Set<string>()
    const next: string[] = []

    const add = (raw: string) => {
      const model = (raw ?? '').trim()
      if (!model) return
      const key = model.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      next.push(model)
    }

    for (const m of providerModelOptions) add(m)
    for (const m of customModels) add(m)

    return next
  }, [customModels, providerModelOptions])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  useEffect(() => {
    setModelOverride('')

    if (project.toolType !== 'Codex') return
    if (typeof window === 'undefined') return

    try {
      const raw = window.localStorage.getItem(modelOverrideStorageKey) ?? ''
      setModelOverride(raw.trim())
    } catch {
      // ignore
    }
  }, [modelOverrideStorageKey, project.toolType])

  useEffect(() => {
    if (project.toolType !== 'Codex') return
    if (typeof window === 'undefined') return

    try {
      const value = modelOverride.trim()
      if (!value) {
        window.localStorage.removeItem(modelOverrideStorageKey)
      } else {
        window.localStorage.setItem(modelOverrideStorageKey, value)
      }
    } catch {
      // ignore
    }
  }, [modelOverride, modelOverrideStorageKey, project.toolType])

  useEffect(() => {
    draftImagesRef.current = draftImages
  }, [draftImages])

  useEffect(() => {
    return () => {
      for (const img of draftImagesRef.current) {
        if (img.localObjectUrl) {
          try {
            URL.revokeObjectURL(img.localObjectUrl)
          } catch {
            // ignore
          }
        }
      }
    }
  }, [])

  const mentionMode = Boolean(mentionToken)
  const activeFileKey = useMemo(
    () => normalizePathForComparison((activeFilePath ?? '').trim()),
    [activeFilePath],
  )

  useEffect(() => {
    if (!activeFileKey) return
    setIncludeActiveFileInPrompt(true)
  }, [activeFileKey])

  useEffect(() => {
    setWorkspaceFiles([])
    setWorkspaceFilesTruncated(false)
    setWorkspaceFilesError(null)
    setWorkspaceFilesLoading(false)
    workspaceFilesCacheRef.current = null
    setMentionedFiles([])
  }, [workspacePath])

  useEffect(() => {
    setProviderModelOptions([])
    setProviderModelsLoaded(false)

    const providerId = project.providerId
    if (!providerId) {
      setProviderModelsLoaded(true)
      return
    }

    let canceled = false
    void (async () => {
      try {
        const providers = await api.providers.list()
        if (canceled) return
        const provider = providers.find((p) => p.id === providerId) ?? null
        setProviderModelOptions(provider?.models ?? [])
      } catch {
        if (!canceled) setProviderModelOptions([])
      } finally {
        if (!canceled) setProviderModelsLoaded(true)
      }
    })()

    return () => {
      canceled = true
    }
  }, [project.providerId])

  useEffect(() => {
    setCustomModels([])
    setCustomModelsLoaded(false)

    try {
      if (typeof window === 'undefined') return

      const raw = window.localStorage.getItem(customModelStorageKey)
      if (!raw) return

      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return

      const models = parsed
        .filter((m): m is string => typeof m === 'string')
        .map((m) => m.trim())
        .filter(Boolean)

      setCustomModels(models)
    } catch {
      // ignore
    } finally {
      setCustomModelsLoaded(true)
    }
  }, [customModelStorageKey])

  useEffect(() => {
    if (project.toolType !== 'Codex') return

    const optionsLoaded = providerModelsLoaded && customModelsLoaded
    if (!optionsLoaded) return

    const selected = modelOverride.trim()
    if (!selected) return

    const map = new Map<string, string>()
    for (const m of availableModels) {
      map.set(m.toLowerCase(), m)
    }

    const normalized = map.get(selected.toLowerCase()) ?? null
    if (!normalized) {
      setModelOverride('')
      return
    }

    if (normalized !== selected) {
      setModelOverride(normalized)
    }
  }, [availableModels, customModelsLoaded, modelOverride, project.toolType, providerModelsLoaded])

  useEffect(() => {
    if (!mentionMode) return
    if (!workspacePath) return

    const cached = workspaceFilesCacheRef.current
    if (
      cached &&
      normalizePathForComparison(cached.workspacePath) === normalizePathForComparison(workspacePath)
    ) {
      setWorkspaceFiles(cached.files)
      setWorkspaceFilesTruncated(cached.truncated)
      setWorkspaceFilesLoading(false)
      setWorkspaceFilesError(null)
      return
    }

    let canceled = false
    setWorkspaceFilesLoading(true)
    setWorkspaceFilesError(null)

    void (async () => {
      try {
        const index = await indexWorkspaceFiles(workspacePath)
        if (canceled) return
        setWorkspaceFiles(index.files)
        setWorkspaceFilesTruncated(index.truncated)
        workspaceFilesCacheRef.current = { workspacePath, files: index.files, truncated: index.truncated }
      } catch (e) {
        if (!canceled) {
          setWorkspaceFilesError((e as Error).message)
        }
      } finally {
        if (!canceled) setWorkspaceFilesLoading(false)
      }
    })()

    return () => {
      canceled = true
    }
  }, [mentionMode, workspacePath])

  const updateMessageText = useCallback((messageId: string, updater: (prev: string) => string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, text: updater(m.text) } : m)),
    )
  }, [])

  const persistCustomModels = useCallback(
    (models: string[]) => {
      setCustomModels(models)
      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(customModelStorageKey, JSON.stringify(models))
      } catch {
        // ignore
      }
    },
    [customModelStorageKey],
  )

  const openAddModelDialog = useCallback(() => {
    setAddModelDraft('')
    setAddModelError(null)
    setAddModelOpen(true)
  }, [])

  const removeDraftImage = useCallback((clientId: string) => {
    setDraftImages((prev) => {
      const target = prev.find((i) => i.clientId === clientId)
      if (target?.localObjectUrl) {
        try {
          URL.revokeObjectURL(target.localObjectUrl)
        } catch {
          // ignore
        }
      }
      return prev.filter((i) => i.clientId !== clientId)
    })
  }, [])

  const addDraftImages = useCallback(
    (files: File[]) => {
      if (!files.length) return

      setChatError(null)

      setDraftImages((prev) => {
        const slots = Math.max(0, maxDraftImages - prev.length)
        const selected = files.slice(0, slots)
        const next: DraftImage[] = [...prev]

        for (const file of selected) {
          const contentType = (file.type ?? '').trim()
          const isImage = contentType.startsWith('image/')

          const localObjectUrl = isImage ? URL.createObjectURL(file) : ''
          const url = localObjectUrl
          const tooLarge = file.size > maxDraftImageBytes
          const clientId = randomId('img')

          next.push({
            clientId,
            url,
            localObjectUrl,
            uploadedId: null,
            fileName: file.name || 'image',
            contentType,
            sizeBytes: file.size,
            status: tooLarge || !isImage ? 'error' : 'uploading',
            error: tooLarge
              ? `图片过大（最大 ${Math.round(maxDraftImageBytes / 1024 / 1024)}MB）`
              : !isImage
                ? '不是图片文件'
                : null,
          })

          if (!tooLarge && isImage) {
            void (async () => {
              try {
                const uploaded = await uploadImage(apiBase, file)
                setDraftImages((cur) =>
                  cur.map((img) => {
                    if (img.clientId !== clientId) return img
                    if (img.localObjectUrl) {
                      try {
                        URL.revokeObjectURL(img.localObjectUrl)
                      } catch {
                        // ignore
                      }
                    }
                    return {
                      ...img,
                      url: uploaded.url,
                      localObjectUrl: '',
                      uploadedId: uploaded.id,
                      fileName: uploaded.fileName || img.fileName,
                      contentType: uploaded.contentType || img.contentType,
                      sizeBytes: uploaded.sizeBytes || img.sizeBytes,
                      status: 'ready',
                      error: null,
                    }
                  }),
                )
              } catch (e) {
                setDraftImages((cur) =>
                  cur.map((img) =>
                    img.clientId === clientId
                      ? { ...img, status: 'error', error: (e as Error).message }
                      : img,
                  ),
                )
              }
            })()
          }
        }

        return next
      })
    },
    [apiBase],
  )

  const activeCodeSelections = useMemo<CodeSelection[]>(() => {
    if (!codeSelection) return []

    const filePathRaw = codeSelection.filePath.trim()
    const text = codeSelection.text
    if (!filePathRaw || !text.trim()) return []

    const startLineCandidate = Number.isFinite(codeSelection.startLine) ? codeSelection.startLine : 1
    const endLineCandidate = Number.isFinite(codeSelection.endLine) ? codeSelection.endLine : startLineCandidate
    const startLine = Math.max(1, Math.floor(Math.min(startLineCandidate, endLineCandidate)))
    const endLine = Math.max(startLine, Math.floor(Math.max(startLineCandidate, endLineCandidate)))

    const displayPath = tryGetWorkspaceRelativePath(workspacePath, filePathRaw) ?? filePathRaw
    return [{ filePath: displayPath, startLine, endLine, text }]
  }, [codeSelection, workspacePath])

  const activeWorkspaceFileRefs = useMemo<WorkspaceFileRef[]>(() => {
    if (!mentionedFiles.length) return []
    return mentionedFiles
      .map((file) => file.relativePath.trim())
      .filter(Boolean)
      .map((filePath) => ({ filePath }))
  }, [mentionedFiles])

  const activeOpenFileBadge = useMemo(() => {
    const filePathRaw = (activeFilePath ?? '').trim()
    if (!filePathRaw) return null

    const relativePath = tryGetWorkspaceRelativePath(workspacePath, filePathRaw) ?? filePathRaw
    const baseName = getBaseName(relativePath)
    const iconUrl = getVscodeFileIconUrl(baseName)
    return { filePath: relativePath, baseName, iconUrl }
  }, [activeFilePath, workspacePath])

  const activeOpenFileRef = useMemo<WorkspaceFileRef | null>(() => {
    if (!includeActiveFileInPrompt) return null
    if (!activeOpenFileBadge) return null
    return { filePath: activeOpenFileBadge.filePath }
  }, [activeOpenFileBadge, includeActiveFileInPrompt])

  const codeSelectionBadge = useMemo(() => {
    if (!codeSelection) return null

    const filePathRaw = codeSelection.filePath.trim()
    const text = codeSelection.text
    if (!filePathRaw || !text.trim()) return null

    const startLine = Math.max(1, Math.floor(Math.min(codeSelection.startLine, codeSelection.endLine)))
    const endLine = Math.max(startLine, Math.floor(Math.max(codeSelection.startLine, codeSelection.endLine)))

    const relativePath = tryGetWorkspaceRelativePath(workspacePath, filePathRaw) ?? filePathRaw
    const baseName = getBaseName(relativePath)
    const iconUrl = getVscodeFileIconUrl(baseName)
    const lineLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`
    return { filePath: relativePath, baseName, iconUrl, startLine, endLine, lineLabel }
  }, [codeSelection, workspacePath])

  const mentionSuggestions = useMemo(() => {
    if (!mentionToken) return []

    const query = mentionToken.query.trim().toLowerCase()
    const out: Array<{
      fullPath: string
      relativePath: string
      baseName: string
      iconUrl: string | null
      score: number
    }> = []

    for (const fullPath of workspaceFiles) {
      const baseName = getBaseName(fullPath)
      const relativePath = tryGetWorkspaceRelativePath(workspacePath, fullPath) ?? fullPath

      const baseLower = baseName.toLowerCase()
      const relLower = relativePath.toLowerCase()
      if (query && !baseLower.includes(query) && !relLower.includes(query)) continue

      let score = 0
      if (query) {
        if (baseLower === query) score = 0
        else if (baseLower.startsWith(query)) score = 1
        else if (baseLower.includes(query)) score = 2
        else if (relLower.includes(`/${query}`)) score = 3
        else score = 4
      }

      out.push({
        fullPath,
        relativePath,
        baseName,
        iconUrl: getVscodeFileIconUrl(baseName),
        score,
      })
    }

    out.sort((a, b) => a.score - b.score || a.relativePath.length - b.relativePath.length)
    return out.slice(0, 12)
  }, [mentionToken, workspaceFiles, workspacePath])

  useEffect(() => {
    setMentionActiveIndex((prev) => {
      if (mentionSuggestions.length <= 1) return 0
      return Math.max(0, Math.min(prev, mentionSuggestions.length - 1))
    })
  }, [mentionSuggestions.length])

  const removeMentionedFile = useCallback((fullPath: string) => {
    const target = normalizePathForComparison(fullPath)
    setMentionedFiles((prev) =>
      prev.filter((file) => normalizePathForComparison(file.fullPath) !== target),
    )
  }, [])

  const applyMentionSuggestion = useCallback(
    (fullPath: string) => {
      if (!mentionToken) return

      const relativePath = tryGetWorkspaceRelativePath(workspacePath, fullPath) ?? fullPath
      const baseName = getBaseName(relativePath)

      setMentionedFiles((prev) => {
        const target = normalizePathForComparison(fullPath)
        if (prev.some((f) => normalizePathForComparison(f.fullPath) === target)) return prev
        return [
          ...prev,
          {
            fullPath,
            relativePath,
            baseName,
            iconUrl: getVscodeFileIconUrl(baseName),
          },
        ]
      })

      const left = draft.slice(0, mentionToken.start)
      const right = draft.slice(mentionToken.end)
      let next = `${left}${right}`
      let nextCaret = mentionToken.start

      if (left && right) {
        const leftChar = left[left.length - 1]
        const rightChar = right[0]
        if (/[A-Za-z0-9_]$/.test(leftChar) && /^[A-Za-z0-9_]/.test(rightChar)) {
          next = `${left} ${right}`
          nextCaret += 1
        }
      }

      setDraft(next)
      setMentionToken(null)
      setMentionActiveIndex(0)

      if (typeof window === 'undefined') return
      window.requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(nextCaret, nextCaret)
      })
    },
    [draft, mentionToken, workspacePath],
  )

  const syncMentionToken = useCallback((value: string, caret: number) => {
    const nextToken = tryGetMentionToken(value, caret)
    setMentionToken(nextToken)
    setMentionActiveIndex(0)
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    const hasBlockingUploads = draftImages.some((img) => img.status !== 'ready')
    const readyImages: ChatImage[] = draftImages
      .filter((img) => img.status === 'ready' && img.uploadedId)
      .map((img) => ({
        id: img.uploadedId as string,
        url: img.url,
        fileName: img.fileName,
        contentType: img.contentType,
        sizeBytes: img.sizeBytes,
      }))

    if (sending) return
    if ((!text && readyImages.length === 0) || hasBlockingUploads) return

    setChatError(null)
    setDraft('')
    setMentionToken(null)
    setMentionActiveIndex(0)
    setMentionedFiles([])
    setDraftImages([])
    setRawEvents([])
    setToolOutput('')
    setActiveReasoningMessageId(null)

    const taskId = randomId('task')
    const userMessageId = `msg-user-${taskId}`
    const agentMessageId = `msg-agent-${taskId}`
    const thinkMessageIdPrefix = `msg-think-${taskId}-`
    let thinkSegmentIndex = 0
    let activeThinkMessageId: string | null = null
    const seenToolCalls = new Set<string>()

    setMessages((prev) => [
      ...prev,
      {
        id: userMessageId,
        role: 'user',
        kind: 'text',
        text,
        ...(readyImages.length ? { images: readyImages } : {}),
      },
      { id: agentMessageId, role: 'agent', kind: 'text', text: '' },
    ])

    setSending(true)
    setActiveTaskId(taskId)
    setCanceling(false)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const imageParts = readyImages.map((img) => ({
        kind: 'image',
        id: img.id,
        url: img.url,
        fileName: img.fileName,
        contentType: img.contentType,
        sizeBytes: img.sizeBytes,
      }))

      const composedText = buildUserPromptWithWorkspaceContext(text, {
        activeFile: activeOpenFileRef ?? undefined,
        selections: activeCodeSelections,
        files: activeWorkspaceFileRefs,
      })

      const request = {
        jsonrpc: '2.0',
        id: randomId('req'),
        method: 'tasks/sendSubscribe',
        params: {
          projectId: project.id,
          cwd: project.workspacePath,
          contextId: sessionIdRef.current,
          taskId,
          ...(modelOverride.trim() ? { model: modelOverride.trim() } : {}),
          message: {
            role: 'user',
            messageId: userMessageId,
            contextId: sessionIdRef.current,
            taskId,
            parts: [...(composedText ? [{ text: composedText }] : []), ...imageParts],
          },
        },
      }

      const res = await fetch(`${apiBase}/api/a2a`, {
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

        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }

        if (!payload || typeof payload !== 'object') continue
        const envelope = payload as { error?: unknown; result?: unknown }

        if (envelope.error) {
          const message =
            typeof envelope.error === 'object' && envelope.error
              ? (envelope.error as { message?: unknown }).message
              : undefined
          throw new Error(typeof message === 'string' ? message : 'A2A error')
        }

        const result = envelope.result ?? null
        if (!result) continue

        if (typeof result !== 'object') continue
        const resultObj = result as {
          statusUpdate?: unknown
          artifactUpdate?: unknown
        }

        const statusUpdate = (resultObj.statusUpdate ?? null) as A2aStatusUpdate | null
        if (statusUpdate?.status?.message?.messageId) {
          const messageId = statusUpdate.status.message.messageId
          const parts = statusUpdate.status.message.parts as unknown[] | undefined
          const chunk = readPartsText(parts)

          if (messageId === agentMessageId && chunk) {
            setActiveReasoningMessageId(null)
            if (statusUpdate.final) {
              updateMessageText(agentMessageId, () => chunk)
            } else {
              updateMessageText(agentMessageId, (prev) => prev + chunk)
            }
          }

          if (statusUpdate.final) {
            setSending(false)
            setActiveReasoningMessageId(null)
            setActiveTaskId(null)
            setCanceling(false)
          }
        }

        const artifactUpdate = (resultObj.artifactUpdate ?? null) as A2aArtifactUpdate | null
        const artifact = artifactUpdate?.artifact
        const artifactName = artifact?.name ?? ''

        if (artifactName === 'tool-output') {
          const parts = (artifact?.parts ?? []) as unknown[]
          const chunk = readPartsText(parts)
          if (chunk) {
            setToolOutput((prev) => prev + chunk)
            onToolOutput?.(chunk)
          }
          continue
        }

        if (artifactName === 'reasoning') {
          const parts = (artifact?.parts ?? []) as unknown[]
          const chunk = readPartsText(parts)
          if (chunk) {
            if (!activeThinkMessageId) {
              thinkSegmentIndex += 1
              activeThinkMessageId = `${thinkMessageIdPrefix}${thinkSegmentIndex}`
            }

            const targetThinkId = activeThinkMessageId
            setActiveReasoningMessageId(targetThinkId)
            setMessages((prev) => upsertThinkChunk(prev, targetThinkId, agentMessageId, chunk))
            setThinkOpenById((prev) =>
              prev[targetThinkId] !== undefined ? prev : { ...prev, [targetThinkId]: true },
            )
          }
          continue
        }

        if (artifactName === 'token-usage') {
          const parts = (artifact?.parts ?? []) as unknown[]
          for (const part of parts) {
            if (!part || typeof part !== 'object') continue
            const dataValue = (part as { data?: unknown }).data
            const normalized = normalizeTokenUsageArtifact(dataValue)
            if (!normalized) continue
            setTokenByMessageId((prev) => ({
              ...prev,
              [agentMessageId]: normalized,
            }))
            break
          }
          continue
        }

        if (artifactName === 'codex-events') {
          const parts = (artifact?.parts ?? []) as unknown[]
          for (const part of parts) {
            if (!part || typeof part !== 'object') continue
            const dataValue = (part as { data?: unknown }).data
            if (!dataValue || typeof dataValue !== 'object') continue

            const dataObj = dataValue as {
              receivedAtUtc?: unknown
              method?: unknown
              raw?: unknown
            }

            const receivedAtUtc = String(dataObj.receivedAtUtc ?? '')
            const method = typeof dataObj.method === 'string' ? dataObj.method : undefined
            const raw = typeof dataObj.raw === 'string' ? dataObj.raw : ''
            if (!raw) continue
            setRawEvents((prev) => [...prev, { receivedAtUtc, method, raw }])

            const toolCall = tryExtractCodexToolCall(raw, method)
            if (!toolCall) continue

            const dedupeKey = toolCall.callId
              ? `call:${toolCall.callId}`
              : `name:${toolCall.toolName}\nargs:${toolCall.toolArgs.slice(0, 256)}`
            if (seenToolCalls.has(dedupeKey)) continue
            seenToolCalls.add(dedupeKey)

            const toolMessageId = toolCall.callId
              ? `msg-tool-${taskId}-${toolCall.callId}`
              : randomId(`msg-tool-${taskId}`)

            const toolMessage: ChatMessage = {
              id: toolMessageId,
              role: 'agent',
              kind: 'tool',
              toolName: toolCall.toolName,
              text: toolCall.toolArgs,
            }

            setToolOpenById((prev) =>
              prev[toolMessageId] !== undefined ? prev : { ...prev, [toolMessageId]: false },
            )

            setMessages((prev) => insertBeforeMessage(prev, agentMessageId, toolMessage))

            // Split reasoning around tool boundaries so the timeline reads:
            // 思考 -> Tool -> 思考 -> Text
            activeThinkMessageId = null
            setActiveReasoningMessageId(null)
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setChatError((e as Error).message)
      }
      setSending(false)
      setActiveReasoningMessageId(null)
      setActiveTaskId(null)
      setCanceling(false)
    }
  }, [
    activeCodeSelections,
    activeOpenFileRef,
    activeWorkspaceFileRefs,
    apiBase,
    draft,
    draftImages,
    modelOverride,
    onToolOutput,
    project.id,
    project.workspacePath,
    sending,
    updateMessageText,
  ])

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

      const res = await fetch(`${apiBase}/api/a2a`, {
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
    <TooltipProvider openDelay={120} closeDelay={60}>
      <>
        <section className="relative min-w-0 flex-1 overflow-hidden flex flex-col">
          {chatError ? (
            <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {chatError}
            </div>
          ) : null}

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 pt-6 pb-40">
            {messages.length ? null : (
              <div className="flex h-full min-h-[160px] items-center justify-center text-center">
                <div className="max-w-sm text-sm text-muted-foreground">
                  在这里开始对话：输入问题或指令。
                </div>
              </div>
            )}

            <ChatMessageList
              messages={messages}
              sending={sending}
              activeTaskId={activeTaskId}
              activeReasoningMessageId={activeReasoningMessageId}
              thinkOpenById={thinkOpenById}
              setThinkOpenById={setThinkOpenById}
              toolOpenById={toolOpenById}
              setToolOpenById={setToolOpenById}
              tokenByMessageId={tokenByMessageId}
            />
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-card via-card/80 to-transparent px-4 pb-4 pt-10">
            <div className="pointer-events-auto mx-auto max-w-3xl">
              <div className="relative rounded-xl border bg-background/80 p-1.5 shadow-lg backdrop-blur">
                {mentionToken ? (
                  <div className="absolute inset-x-2 bottom-full mb-2 overflow-hidden rounded-xl border bg-popover shadow-lg">
                    <div className="border-b px-2 py-1 text-[11px] text-muted-foreground">
                      文件搜索：{mentionToken.query ? `@${mentionToken.query}` : '@'}
                      {workspaceFilesTruncated ? '（已截断）' : ''}
                    </div>
                    <div className="max-h-[260px] overflow-auto p-1">
                      {!workspacePath ? (
                        <div className="px-2 py-2 text-xs text-muted-foreground">未设置工作空间</div>
                      ) : workspaceFilesError ? (
                        <div className="px-2 py-2 text-xs text-destructive">{workspaceFilesError}</div>
                      ) : workspaceFilesLoading && !workspaceFiles.length ? (
                        <div className="px-2 py-2 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-2">
                            <Spinner className="size-3" /> 索引工作区文件中…
                          </span>
                        </div>
                      ) : mentionSuggestions.length ? (
                        <div className="space-y-0.5">
                          {mentionSuggestions.map((item, idx) => (
                            <button
                              key={item.fullPath}
                              type="button"
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                                idx === mentionActiveIndex
                                  ? 'bg-accent text-accent-foreground'
                                  : 'hover:bg-accent/50',
                              )}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => applyMentionSuggestion(item.fullPath)}
                            >
                              {item.iconUrl ? (
                                <img
                                  src={item.iconUrl}
                                  alt=""
                                  aria-hidden="true"
                                  draggable={false}
                                  className="size-4.5 shrink-0"
                                />
                              ) : (
                                <span className="size-4.5 shrink-0" aria-hidden="true" />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm">{item.baseName}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {item.relativePath}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="px-2 py-2 text-xs text-muted-foreground">未找到匹配文件</div>
                      )}
                    </div>
                  </div>
                ) : null}
                <div className="space-y-2">
                  {activeOpenFileBadge ? (
                    <div className="flex flex-wrap gap-2 px-1">
                      <Badge
                        variant="secondary"
                        className={cn(
                          'max-w-full min-w-0 gap-2 pr-1',
                          includeActiveFileInPrompt ? '' : 'opacity-60',
                        )}
                        title={activeOpenFileBadge.filePath}
                      >
                        {activeOpenFileBadge.iconUrl ? (
                          <img
                            src={activeOpenFileBadge.iconUrl}
                            alt=""
                            aria-hidden="true"
                            draggable={false}
                            className="size-4 shrink-0"
                          />
                        ) : null}
                        <span className="min-w-0 truncate">
                          当前文件：{activeOpenFileBadge.filePath}
                        </span>
                        <button
                          type="button"
                          className="ml-auto inline-flex rounded-sm p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setIncludeActiveFileInPrompt((prev) => !prev)}
                          title={includeActiveFileInPrompt ? '点击后不加入提示词' : '点击后加入提示词'}
                        >
                          {includeActiveFileInPrompt ? (
                            <Eye className="size-3" />
                          ) : (
                            <EyeOff className="size-3" />
                          )}
                        </button>
                      </Badge>
                    </div>
                  ) : null}
                  {mentionedFiles.length ? (
                    <div className="flex flex-wrap gap-2 px-1">
                      {mentionedFiles.map((file) => (
                        <Badge
                          key={file.fullPath}
                          variant="secondary"
                          className="max-w-full min-w-0 gap-2 pr-1"
                          title={file.relativePath}
                        >
                          {file.iconUrl ? (
                            <img
                              src={file.iconUrl}
                              alt=""
                              aria-hidden="true"
                              draggable={false}
                              className="size-4 shrink-0"
                            />
                          ) : null}
                          <span className="min-w-0 truncate">{file.relativePath}</span>
                          <button
                            type="button"
                            className="ml-auto inline-flex rounded-sm p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground"
                            onClick={() => removeMentionedFile(file.fullPath)}
                            title="移除引用文件"
                          >
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {codeSelectionBadge ? (
                    <div className="flex flex-wrap gap-2 px-1">
                      <Badge variant="secondary" className="max-w-full min-w-0 gap-2 pr-1">
                        {codeSelectionBadge.iconUrl ? (
                          <img
                            src={codeSelectionBadge.iconUrl}
                            alt=""
                            aria-hidden="true"
                            draggable={false}
                            className="size-4 shrink-0"
                          />
                        ) : null}
                        <span className="min-w-0 truncate">
                          {codeSelectionBadge.filePath} {codeSelectionBadge.lineLabel}
                        </span>
                        {onClearCodeSelection ? (
                          <button
                            type="button"
                            className="ml-auto inline-flex rounded-sm p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground"
                            onClick={onClearCodeSelection}
                            title="移除选中代码"
                          >
                            <X className="size-3" />
                          </button>
                        ) : null}
                      </Badge>
                    </div>
                  ) : null}
                  {draftImages.length ? (
                    <div className="flex flex-wrap gap-2 px-1">
                      {draftImages.map((img) => (
                        <div
                          key={img.clientId}
                          className={cn(
                            'relative size-16 overflow-hidden rounded-md border bg-background/30',
                            img.status === 'error' ? 'border-destructive' : '',
                          )}
                        >
                          {img.url ? (
                            <img
                              src={img.url}
                              alt={img.fileName}
                              className="h-full w-full object-cover"
                              draggable={false}
                            />
                          ) : null}

                          <button
                            type="button"
                            className={cn(
                              'absolute right-1 top-1 rounded-sm bg-background/70 p-1 text-muted-foreground',
                              'hover:bg-background hover:text-foreground',
                            )}
                            onClick={() => removeDraftImage(img.clientId)}
                            title="移除"
                          >
                            <X className="size-3" />
                          </button>

                          {img.status === 'uploading' ? (
                            <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                              <Spinner />
                            </div>
                          ) : null}

                          {img.status === 'error' && img.error ? (
                            <div className="absolute inset-x-0 bottom-0 bg-destructive/80 px-1 py-0.5 text-[10px] text-white">
                              {img.error}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      disabled={sending}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? [])
                        e.target.value = ''
                        addDraftImages(files)
                      }}
                    />

                    <textarea
                      ref={textareaRef}
                      className="min-h-[40px] max-h-[160px] w-full resize-none rounded-xl bg-background px-3 py-1.5 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
                      placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                      value={draft}
                      disabled={sending}
                      onChange={(e) => {
                        const value = e.target.value
                        setDraft(value)
                        syncMentionToken(value, e.target.selectionStart ?? value.length)
                      }}
                      onSelect={(e) => {
                        const value = e.currentTarget.value
                        syncMentionToken(value, e.currentTarget.selectionStart ?? value.length)
                      }}
                      onPaste={(e) => {
                        const items = Array.from(e.clipboardData?.items ?? [])
                        const imageFiles = items
                          .filter((i) => i.type.startsWith('image/'))
                          .map((i) => i.getAsFile())
                          .filter(Boolean) as File[]

                        if (imageFiles.length) {
                          e.preventDefault()
                          addDraftImages(imageFiles)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (mentionToken && !e.shiftKey) {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setMentionToken(null)
                            setMentionActiveIndex(0)
                            return
                          }

                          if (mentionSuggestions.length) {
                            if (e.key === 'ArrowDown') {
                              e.preventDefault()
                              setMentionActiveIndex((prev) =>
                                Math.min(prev + 1, Math.max(0, mentionSuggestions.length - 1)),
                              )
                              return
                            }

                            if (e.key === 'ArrowUp') {
                              e.preventDefault()
                              setMentionActiveIndex((prev) => Math.max(0, prev - 1))
                              return
                            }

                            if (e.key === 'Tab') {
                              e.preventDefault()
                              applyMentionSuggestion(mentionSuggestions[mentionActiveIndex].fullPath)
                              return
                            }

                            if (e.key === 'Enter') {
                              e.preventDefault()
                              applyMentionSuggestion(mentionSuggestions[mentionActiveIndex].fullPath)
                              return
                            }
                          }

                          if (workspaceFilesLoading && e.key === 'Enter') {
                            e.preventDefault()
                            return
                          }
                        }

                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void send()
                        }
                      }}
                    />

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        disabled={sending || draftImages.length >= maxDraftImages}
                        onClick={() => fileInputRef.current?.click()}
                        title="上传图片"
                      >
                        <ImageIcon className="size-4" />
                        <span className="sr-only">上传图片</span>
                      </Button>

                      {project.toolType === 'Codex' ? (
                        <Select
                          value={modelOverride.trim() ? modelOverride.trim() : modelDefaultSentinel}
                          disabled={sending}
                          onValueChange={(value) => {
                            if (value === addModelSentinel) {
                              openAddModelDialog()
                              return
                            }

                            if (value === modelDefaultSentinel) {
                              setModelOverride('')
                              return
                            }

                            setModelOverride(value)
                          }}
                        >
                          <SelectTrigger
                            className="h-8 w-[180px] shrink-0 px-2 text-xs"
                            title="选择模型"
                          >
                            <SelectValue placeholder="选择模型" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={modelDefaultSentinel}>
                              项目默认{project.model ? ` (${project.model})` : ''}
                            </SelectItem>
                            {availableModels.length ? (
                              <>
                                <SelectSeparator />
                                {availableModels.map((m) => (
                                  <SelectItem key={m} value={m}>
                                    {m}
                                  </SelectItem>
                                ))}
                              </>
                            ) : null}
                            <SelectSeparator />
                            <SelectItem value={addModelSentinel}>+ 添加模型…</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : null}

                      <div className="ml-auto flex items-center gap-2">
                        {sending ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void cancel()}
                            disabled={canceling}
                          >
                            {canceling ? '停止中…' : '停止'}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void send()}
                            disabled={
                              (!draft.trim() &&
                                draftImages.filter((img) => img.status === 'ready').length ===
                                  0) ||
                              draftImages.some((img) => img.status !== 'ready')
                            }
                          >
                            发送
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <Modal
          open={addModelOpen}
          title="添加模型"
          onClose={() => {
            setAddModelOpen(false)
            setAddModelDraft('')
            setAddModelError(null)
          }}
          className="max-w-lg"
        >
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              请输入模型名称（例如：gpt-5.1-codex-max）。
            </div>
            <Input
              autoFocus
              value={addModelDraft}
              onChange={(e) => {
                setAddModelDraft(e.target.value)
                if (addModelError) setAddModelError(null)
              }}
              placeholder="模型名称"
            />
            {addModelError ? <div className="text-sm text-destructive">{addModelError}</div> : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAddModelOpen(false)
                  setAddModelDraft('')
                  setAddModelError(null)
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const model = addModelDraft.trim()
                  if (!model) {
                    setAddModelError('请输入模型名称')
                    return
                  }

                  if (model.length > 200) {
                    setAddModelError('模型名称过长')
                    return
                  }

                  const lower = model.toLowerCase()
                  const providerHas = providerModelOptions.some((m) => m.toLowerCase() === lower)
                  const customHas = customModels.some((m) => m.toLowerCase() === lower)

                  if (!providerHas && !customHas) {
                    const map = new Map<string, string>()
                    for (const existing of customModels) {
                      const normalized = existing.trim()
                      if (!normalized) continue
                      map.set(normalized.toLowerCase(), normalized)
                    }
                    map.set(lower, model)
                    persistCustomModels(Array.from(map.values()))
                  }

                  setModelOverride(model)
                  setAddModelOpen(false)
                  setAddModelDraft('')
                  setAddModelError(null)
                }}
              >
                添加
              </Button>
            </div>
          </div>
        </Modal>

        {detailsOpen && detailsPortalTarget
          ? createPortal(
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!toolOutput}
                        onClick={() => setToolOutput('')}
                      >
                        清空输出
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!rawEvents.length}
                        onClick={() => setRawEvents([])}
                      >
                        清空事件
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 space-y-4">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">
                        Tool Output
                      </div>
                      {toolOutput ? (
                        <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-2 text-[11px]">
                          {toolOutput}
                        </pre>
                      ) : (
                        <div className="mt-2 text-xs text-muted-foreground">（无）</div>
                      )}
                    </div>

                    <div>
                      <div className="text-xs font-medium text-muted-foreground">
                        Raw Events
                      </div>
                      <div className="mt-2 space-y-2">
                        {rawEvents.length ? null : (
                          <div className="text-xs text-muted-foreground">（无）</div>
                        )}
                        {rawEvents.map((e, idx) => (
                          <div
                            key={`${e.receivedAtUtc}-${idx}`}
                            className="rounded-md border bg-background p-2"
                          >
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
                </div>
              </div>,
              detailsPortalTarget,
            )
          : null}
      </>
    </TooltipProvider>
  )
}
