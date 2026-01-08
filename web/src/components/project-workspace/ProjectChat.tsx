import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  isValidElement,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import { jsonrepair } from 'jsonrepair'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { api } from '@/api/client'
import type { ProjectDto, ProjectSessionMessageDto, ProviderDto } from '@/api/types'
import type { CodeSelection, WorkspaceFileRef } from '@/lib/chatPromptXml'
import { buildUserPromptWithWorkspaceContext } from '@/lib/chatWorkspaceContextXml'
import { cn } from '@/lib/utils'
import { getVscodeFileIconUrl } from '@/lib/vscodeFileIcons'
import { ShikiCode } from '@/components/ShikiCode'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
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
import { Check, ChevronDown, Eye, EyeOff, Image as ImageIcon, X } from 'lucide-react'
import { useRouteTool } from '@/hooks/use-route-tool'
import { useToolInputParsers } from '@/components/project-workspace/tool-inputs/useToolInputParsers'
import { ToolItemContent } from '@/components/project-workspace/tool-contents/ToolItemContent'
import { ClaudeTodoWriteTool } from '@/components/project-workspace/ClaudeTodoWriteTool'
import { tryParseTodoWriteToolInput } from '@/lib/toolInputParsers'

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
  toolUseId?: string
  toolInput?: string
  toolOutput?: string
  toolIsError?: boolean
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

type ModelSelection = {
  providerId: string
  model: string
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
const sessionHistoryPageSize = 30
const sessionHistoryLoadThresholdPx = 96

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
    if (!part) continue
    if (typeof part === 'string') {
      if (part) chunks.push(part)
      continue
    }
    if (typeof part !== 'object') continue

    const p = part as { text?: unknown; data?: unknown }
    if (typeof p.text === 'string' && p.text) {
      chunks.push(p.text)
      continue
    }

    if (p.data && typeof p.data === 'object') {
      const dataObj = p.data as { text?: unknown }
      if (typeof dataObj.text === 'string' && dataObj.text) chunks.push(dataObj.text)
    }
  }
  return chunks.join('')
}

function truncateInlineText(value: string, maxChars = 140): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, Math.max(0, maxChars - 1)) + '…'
}

function normalizeNewlines(value: string): string {
  return (value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function tryExtractFirstJsonValueSlice(
  value: string,
): { jsonText: string; trailingText: string } | null {
  const raw = (value ?? '').trim()
  if (!raw) return null

  const firstObj = raw.indexOf('{')
  const firstArr = raw.indexOf('[')

  let start = -1
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) start = firstObj
  else start = firstArr

  if (start < 0) return null

  const stack: Array<'{' | '['> = []
  let inString = false
  let escapeNext = false

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]

    if (inString) {
      if (escapeNext) {
        escapeNext = false
        continue
      }
      if (ch === '\\') {
        escapeNext = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch)
      continue
    }

    if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '['
      if (!stack.length || stack[stack.length - 1] !== expected) return null
      stack.pop()
      if (stack.length === 0) {
        return {
          jsonText: raw.slice(start, i + 1),
          trailingText: raw.slice(i + 1),
        }
      }
    }
  }

  return null
}

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  const raw = (value ?? '').trim()
  if (!raw) return null

  const start = raw.indexOf('{')
  if (start < 0) return null
  const end = raw.lastIndexOf('}')
  const wideCandidate = end > start ? raw.slice(start, end + 1) : raw.slice(start)
  const balancedCandidate = tryExtractFirstJsonValueSlice(raw)?.jsonText ?? null

  const parseRecord = (jsonText: string): Record<string, unknown> | null => {
    const parsed = JSON.parse(jsonText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  }

  const candidates = [balancedCandidate, wideCandidate].filter((c): c is string => Boolean(c))
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)

    try {
      const parsed = parseRecord(candidate)
      if (parsed) return parsed
    } catch {
      // ignore
    }

    try {
      const parsed = parseRecord(jsonrepair(candidate))
      if (parsed) return parsed
    } catch {
      // ignore
    }
  }

  return null
}

function readFirstNonEmptyString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

function normalizeToolNameKey(toolName: string): string {
  return (toolName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isWriteToolName(toolName: string): boolean {
  const key = normalizeToolNameKey(toolName)
  return key === 'write' || key.endsWith('write') || key.includes('mcpclaudewrite')
}

function isEditToolName(toolName: string): boolean {
  const key = normalizeToolNameKey(toolName)
  return key === 'edit' || key.endsWith('edit') || key.includes('mcpclaudeedit')
}

function isAskUserQuestionToolName(toolName: string): boolean {
  const key = normalizeToolNameKey(toolName)
  return (
    key === 'askuserquestion' ||
    key.endsWith('askuserquestion') ||
    key.includes('mcpclaudeaskuserquestion')
  )
}

function isReadToolName(toolName: string): boolean {
  const key = normalizeToolNameKey(toolName)
  return key === 'read' || key.endsWith('read') || key.includes('mcpclauderead')
}

function isTodoWriteToolName(toolName: string): boolean {
  const key = normalizeToolNameKey(toolName)
  return key === 'todowrite' || key.endsWith('todowrite') || key.includes('mcpclaudetodowrite')
}

function isTaskToolName(toolName: string): boolean {
  const key = normalizeToolNameKey(toolName)
  return key === 'task' || key.endsWith('task')
}

function shouldAutoOpenClaudeTool(toolName: string): boolean {
  return (
    isWriteToolName(toolName) ||
    isEditToolName(toolName) ||
    isAskUserQuestionToolName(toolName) ||
    isReadToolName(toolName) ||
    isTodoWriteToolName(toolName)
  )
}

function tryParseJsonValue(value: string): unknown | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // ignore
  }

  try {
    return JSON.parse(jsonrepair(trimmed)) as unknown
  } catch {
    return null
  }
}

function tryExtractReadToolOutput(output: string): string | null {
  const trimmed = (output ?? '').trim()
  if (!trimmed) return null
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null

  const parsed = tryParseJsonValue(trimmed)
  if (!parsed) return null

  const extract = (value: unknown): { filePath?: string; content: string } | null => {
    if (value == null) return null

    if (typeof value === 'string') {
      const nestedTrimmed = value.trim()
      if (nestedTrimmed.startsWith('{') || nestedTrimmed.startsWith('[')) {
        const nested = tryParseJsonValue(nestedTrimmed)
        const nestedExtracted = nested ? extract(nested) : null
        if (nestedExtracted) return nestedExtracted
      }
      return { content: value }
    }

    if (Array.isArray(value)) {
      const parts: string[] = []
      for (const entry of value) {
        const extracted = extract(entry)
        if (!extracted) continue
        if (extracted.content) parts.push(extracted.content)
      }
      const joined = parts.join('\n').trimEnd()
      return joined ? { content: joined } : null
    }

    if (typeof value !== 'object') return null
    const obj = value as Record<string, unknown>

    const fileValue = obj.file
    if (fileValue && typeof fileValue === 'object' && !Array.isArray(fileValue)) {
      const fileObj = fileValue as Record<string, unknown>
      const content = typeof fileObj.content === 'string' ? fileObj.content : null
      if (content != null) {
        const filePath =
          (typeof fileObj.filePath === 'string' ? fileObj.filePath : undefined) ??
          (typeof fileObj.file_path === 'string' ? fileObj.file_path : undefined)
        return { filePath, content }
      }
    }

    const contentValue = obj.content
    if (typeof contentValue === 'string') return { content: contentValue }

    const textValue = obj.text
    if (typeof textValue === 'string') {
      const nestedTrimmed = textValue.trim()
      if (nestedTrimmed.startsWith('{') || nestedTrimmed.startsWith('[')) {
        const nested = tryParseJsonValue(nestedTrimmed)
        const nestedExtracted = nested ? extract(nested) : null
        if (nestedExtracted) return nestedExtracted
      }
      return { content: textValue }
    }

    const dataValue = obj.data
    if (dataValue) return extract(dataValue)

    return null
  }

  const extracted = extract(parsed)
  if (!extracted?.content) return null
  return extracted.content
}

function normalizeReadToolOutputForMonaco(output: string): string {
  const normalized = normalizeNewlines(output ?? '')
  if (!normalized) return ''

  const lines = normalized.split('\n')
  if (lines.length < 2) return normalized

  const patterns: RegExp[] = [
    /^\s*(\d+)\t(.*)$/,
    /^\s*(\d+)\s*->\s?(.*)$/,
    /^\s*(\d+)\s*→\s?(.*)$/,
  ]

  for (const pattern of patterns) {
    const matches = lines.map((line) => pattern.exec(line))
    const matchedCount = matches.reduce((acc, m) => acc + (m ? 1 : 0), 0)
    if (matchedCount < Math.max(2, Math.floor(lines.length * 0.8))) continue

    let numCount = 0
    let seqCount = 0
    let prevNum: number | null = null
    for (const match of matches) {
      if (!match) continue
      const num = Number(match[1])
      if (!Number.isFinite(num)) continue
      if (prevNum != null && num === prevNum + 1) seqCount += 1
      prevNum = num
      numCount += 1
    }

    if (numCount > 2 && seqCount < Math.floor((numCount - 1) * 0.6)) continue

    return matches.map((m, idx) => (m ? m[2] : lines[idx])).join('\n')
  }

  return normalized
}

function extractInlineThink(text: string): { thinkText: string; visibleText: string } | null {
  const raw = text ?? ''
  const start = raw.indexOf('<think>')
  if (start < 0) return null

  const end = raw.indexOf('</think>', start + '<think>'.length)
  if (end < 0 || end <= start) return null

  const before = raw.slice(0, start)
  const thinkText = raw.slice(start + '<think>'.length, end).trim()
  const after = raw.slice(end + '</think>'.length)

  if (!thinkText.trim()) return null

  const beforeTrimmedEnd = before.replace(/\s+$/, '')
  const afterTrimmedStart = after.replace(/^\s+/, '')
  const spacer = beforeTrimmedEnd && afterTrimmedStart ? '\n\n' : ''
  const visibleText = `${beforeTrimmedEnd}${spacer}${afterTrimmedStart}`

  return { thinkText, visibleText }
}

function getInlineThinkId(agentMessageId: string): string {
  return `${agentMessageId}-inline-think`
}

type ReplacementLineDiffOp = { type: 'equal' | 'add' | 'del'; text: string }

function splitTextLinesForDiff(value: string): string[] {
  const normalized = normalizeNewlines(value ?? '')
  if (!normalized) return []

  const withoutFinalNewline = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  if (!withoutFinalNewline) return []

  return withoutFinalNewline.split('\n')
}

function backtrackMyersDiff(
  trace: number[][],
  oldLines: string[],
  newLines: string[],
  offset: number,
): ReplacementLineDiffOp[] {
  let x = oldLines.length
  let y = newLines.length
  const ops: ReplacementLineDiffOp[] = []

  for (let d = trace.length - 1; d > 0; d -= 1) {
    const vPrev = trace[d - 1]
    const k = x - y

    const prevK =
      k === -d || (k !== d && (vPrev[k - 1 + offset] ?? 0) < (vPrev[k + 1 + offset] ?? 0))
        ? k + 1
        : k - 1

    const prevX = vPrev[prevK + offset] ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', text: oldLines[x - 1] ?? '' })
      x -= 1
      y -= 1
    }

    if (x === prevX) {
      ops.push({ type: 'add', text: newLines[y - 1] ?? '' })
      y -= 1
    } else {
      ops.push({ type: 'del', text: oldLines[x - 1] ?? '' })
      x -= 1
    }
  }

  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', text: oldLines[x - 1] ?? '' })
    x -= 1
    y -= 1
  }

  while (x > 0) {
    ops.push({ type: 'del', text: oldLines[x - 1] ?? '' })
    x -= 1
  }

  while (y > 0) {
    ops.push({ type: 'add', text: newLines[y - 1] ?? '' })
    y -= 1
  }

  return ops.reverse()
}

function computeMyersLineDiff(oldLines: string[], newLines: string[]): ReplacementLineDiffOp[] {
  const n = oldLines.length
  const m = newLines.length
  const max = n + m
  const offset = max

  const v = new Array<number>(2 * max + 1).fill(0)
  const trace: number[][] = []

  for (let d = 0; d <= max; d += 1) {
    const nextV = v.slice()

    for (let k = -d; k <= d; k += 2) {
      const kIndex = k + offset

      let x: number
      if (k === -d || (k !== d && v[k + 1 + offset] > v[k - 1 + offset])) {
        x = v[k + 1 + offset]
      } else {
        x = v[k - 1 + offset] + 1
      }

      let y = x - k

      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1
        y += 1
      }

      nextV[kIndex] = x

      if (x >= n && y >= m) {
        trace.push(nextV)
        return backtrackMyersDiff(trace, oldLines, newLines, offset)
      }
    }

    trace.push(nextV)
    for (let i = 0; i < nextV.length; i += 1) v[i] = nextV[i]
  }

  return backtrackMyersDiff(trace, oldLines, newLines, offset)
}

function buildReplacementDiff(filePath: string, oldString: string, newString: string): string {
  const path = (filePath ?? '').replace(/\\/g, '/')
  const oldLines = splitTextLinesForDiff(oldString)
  const newLines = splitTextLinesForDiff(newString)

  const ops = computeMyersLineDiff(oldLines, newLines).filter((op) => op.type !== 'equal')
  if (!ops.length) return ''

  const oldCount = Math.max(1, oldLines.length)
  const newCount = Math.max(1, newLines.length)

  const hunk = `@@ -1,${oldCount} +1,${newCount} @@`

  const body = ops
    .map((op) => `${op.type === 'add' ? '+' : '-'}${op.text}`)
    .join('\n')

  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}\n${body}`
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

function sortJsonValue(value: unknown): unknown {
  if (value == null) return value
  if (Array.isArray(value)) return value.map((v) => sortJsonValue(v))
  if (typeof value !== 'object') return value

  const obj = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b))
  for (const key of keys) {
    next[key] = sortJsonValue(obj[key])
  }
  return next
}

function tryStableJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(sortJsonValue(value))
  } catch {
    return null
  }
}

function mergeStreamingToolText(existing: string, incoming: string): string {
  const prev = existing ?? ''
  const next = incoming ?? ''

  if (!next) return prev
  if (!prev) return next
  if (next === prev) return prev

  if (next.startsWith(prev)) return next
  if (prev.startsWith(next)) return prev
  if (next.includes(prev)) return next
  if (prev.includes(next)) return prev

  const prevRecord = tryParseJsonRecord(prev)
  const nextRecord = tryParseJsonRecord(next)
  if (prevRecord && nextRecord) {
    const stablePrev = tryStableJsonStringify(prevRecord)
    const stableNext = tryStableJsonStringify(nextRecord)
    if (stablePrev && stablePrev === stableNext) {
      const prevTrimmed = prev.trim()
      const nextTrimmed = next.trim()
      const prevSlice = tryExtractFirstJsonValueSlice(prevTrimmed)
      const nextSlice = tryExtractFirstJsonValueSlice(nextTrimmed)
      const prevIsWholeJson =
        Boolean(prevSlice) && prevTrimmed === prevSlice?.jsonText && !prevSlice?.trailingText.trim()
      const nextIsWholeJson =
        Boolean(nextSlice) && nextTrimmed === nextSlice?.jsonText && !nextSlice?.trailingText.trim()

      if (prevIsWholeJson !== nextIsWholeJson) {
        return prevIsWholeJson ? prev : next
      }

      if (!prevIsWholeJson && !nextIsWholeJson) {
        return prev.length <= next.length ? prev : next
      }

      return prev.length >= next.length ? prev : next
    }
  }

  return prev + next
}

function mergeStreamingText(existing: string, incoming: string): string {
  const prev = existing ?? ''
  const next = incoming ?? ''

  if (!next) return prev
  if (!prev) return next
  if (next === prev) return prev

  if (next.startsWith(prev)) return next
  if (prev.startsWith(next)) return prev
  if (next.includes(prev)) return next
  if (prev.includes(next)) return prev

  return prev + next
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

type CodexAgentMessageInfo = {
  messageId?: string
  text: string
}

function readCodexAgentText(value: unknown, depth = 0): string | null {
  if (value == null || depth > 4) return null

  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const joined = readPartsText(value)
    return joined || null
  }

  if (typeof value !== 'object') return null
  const obj = value as Record<string, unknown>

  const direct = readFirstNonEmptyString(obj, [
    'message',
    'text',
    'last_agent_message',
    'lastAgentMessage',
  ])
  if (direct) return direct

  const contentValue = obj.content ?? obj.parts
  const contentText = readCodexAgentText(contentValue, depth + 1)
  if (contentText) return contentText

  const nestedCandidates = [obj.item, obj.msg, obj.message, obj.data]
  for (const candidate of nestedCandidates) {
    const nestedText = readCodexAgentText(candidate, depth + 1)
    if (nestedText) return nestedText
  }

  return null
}

function tryExtractCodexAgentMessage(raw: string, method?: string): CodexAgentMessageInfo | null {
  const combined = `${method ?? ''}\n${raw}`.toLowerCase()
  const mightContainMessage =
    combined.includes('agent_message') ||
    combined.includes('agentmessage') ||
    combined.includes('item_completed') ||
    combined.includes('task_complete') ||
    combined.includes('item/completed') ||
    combined.includes('task_complete') ||
    combined.includes('last_agent_message')

  if (!mightContainMessage) return null

  const parsed = tryParseJsonRecord(raw)
  if (!parsed) return null

  const paramsValue = parsed.params
  const candidates: unknown[] = []
  if (paramsValue && typeof paramsValue === 'object') {
    const params = paramsValue as Record<string, unknown>
    candidates.push(
      params.msg,
      params.item,
      params.message,
      params,
      (params.msg && typeof params.msg === 'object' ? (params.msg as Record<string, unknown>).item : null),
    )
  } else {
    candidates.push(paramsValue)
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const obj = candidate as Record<string, unknown>
    const text = readCodexAgentText(obj, 0)
    if (!text) continue

    const messageId =
      readFirstNonEmptyString(obj, ['messageId', 'message_id', 'id']) ??
      (obj.item && typeof obj.item === 'object'
        ? readFirstNonEmptyString(obj.item as Record<string, unknown>, [
            'messageId',
            'message_id',
            'id',
          ])
        : null) ??
      undefined

    return { messageId, text }
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

export type OpenById = Record<string, boolean>
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

function formatToolCallCount(count: number): string {
  const n = Math.max(0, count)
  return `${n} tool call${n === 1 ? '' : 's'}`
}

function computeReplacementDiffStats(oldString: string, newString: string): { added: number; removed: number } {
  const oldLines = splitTextLinesForDiff(oldString)
  const newLines = splitTextLinesForDiff(newString)
  const ops = computeMyersLineDiff(oldLines, newLines)

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'add') added += 1
    else if (op.type === 'del') removed += 1
  }

  return { added, removed }
}

const ChatToolCallItem = memo(function ChatToolCallItem({
  message,
  openById,
  onToggle,
  onSubmitAskUserQuestion,
  askUserQuestionDisabled,
}: {
  message: ChatMessage
  openById: OpenById
  onToggle: (id: string) => void
  onSubmitAskUserQuestion?: (toolUseId: string, answers: Record<string, string>, messageId: string) => void
  askUserQuestionDisabled: boolean
}) {
  const open = openById[message.id] ?? false
  const toolName = message.toolName ?? 'tool'
  const input = message.toolInput ?? message.text ?? ''
  const output = message.toolOutput ?? ''
  const isError = Boolean(message.toolIsError)

  const inputData = useToolInputParsers(toolName, input)

  const diffStats = useMemo(() => {
    if (!inputData.editInput) return null
    if (normalizeNewlines(inputData.editInput.oldString) === normalizeNewlines(inputData.editInput.newString)) {
      return null
    }
    return computeReplacementDiffStats(inputData.editInput.oldString, inputData.editInput.newString)
  }, [inputData.editInput])

  const editDiff = useMemo(() => {
    if (!inputData.editInput) return ''
    if (normalizeNewlines(inputData.editInput.oldString) === normalizeNewlines(inputData.editInput.newString)) {
      return ''
    }
    return buildReplacementDiff(inputData.editInput.filePath, inputData.editInput.oldString, inputData.editInput.newString)
  }, [inputData.editInput])

  const fallbackReadCode = useMemo(() => {
    if (!inputData.readInput) return null
    if (inputData.readInput.content != null) {
      return normalizeReadToolOutputForMonaco(inputData.readInput.content)
    }
    const extracted = tryExtractReadToolOutput(output)
    return normalizeReadToolOutputForMonaco(extracted ?? output)
  }, [output, inputData.readInput])

  const [readCodeFromApi, setReadCodeFromApi] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!inputData.readInput) {
      setReadCodeFromApi(null)
      return
    }

    const { filePath, offset, limit } = inputData.readInput
    setReadCodeFromApi(null)

    void (async () => {
      try {
        const data = await api.fs.readFile(filePath, { offset, limit })
        if (cancelled) return
        setReadCodeFromApi(normalizeReadToolOutputForMonaco(data.content ?? ''))
      } catch {
        if (!cancelled) setReadCodeFromApi(null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [inputData.readInput?.filePath, inputData.readInput?.offset, inputData.readInput?.limit])

  const readCode = readCodeFromApi ?? fallbackReadCode

  const title = useMemo(() => {
    if (inputData.editInput) {
      return `Edit ${getBaseName(inputData.editInput.filePath)}`
    }
    if (inputData.writeInput) {
      return `Write ${getBaseName(inputData.writeInput.filePath)}`
    }
    if (inputData.readInput) {
      return `Read ${getBaseName(inputData.readInput.filePath)}`
    }
    if (inputData.taskInput) {
      return `Task${inputData.taskInput.subagentType ? ` ${inputData.taskInput.subagentType}` : ''}`
    }
    if (inputData.askInput?.questions?.length) {
      return 'AskUserQuestion'
    }
    if (inputData.todoWriteInput) {
      return 'TodoWrite'
    }
    return toolName
  }, [inputData, toolName])

  const inputPreview = useMemo(() => {
    if (inputData.askInput?.questions?.length) {
      return truncateInlineText(inputData.askInput.questions[0].question, 140)
    }
    if (inputData.writeInput) {
      return truncateInlineText(inputData.writeInput.filePath, 140)
    }
    if (inputData.readInput) {
      return truncateInlineText(inputData.readInput.filePath, 140)
    }
    if (inputData.taskInput) {
      return truncateInlineText(inputData.taskInput.description || inputData.taskInput.prompt || inputData.taskInput.subagentType, 140)
    }
    if (inputData.editInput) {
      return truncateInlineText(inputData.editInput.filePath, 140)
    }
    if (inputData.todoWriteInput) {
      return inputData.todoWriteInput.todos.length
        ? `${inputData.todoWriteInput.todos.length} todos`
        : '0 todos'
    }
    if (input) {
      return truncateInlineText(input, 140)
    }
    return ''
  }, [inputData, input])

  return (
    <div className="rounded-md border bg-background/40">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          '!h-auto w-full items-start justify-between gap-3 px-2 py-2 text-xs font-medium text-muted-foreground',
          'hover:bg-accent/40',
        )}
        aria-expanded={open}
        aria-controls={`tool-item-${message.id}`}
        onClick={() => onToggle(message.id)}
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground/90">{title}</span>
            {diffStats ? (
              <>
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-emerald-400">
                  +{diffStats.added}
                </Badge>
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-rose-400">
                  -{diffStats.removed}
                </Badge>
              </>
            ) : null}
            {isError ? (
              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                error
              </Badge>
            ) : null}
          </span>
          {inputPreview ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{inputPreview}</span>
          ) : null}
        </span>
        <ChevronDown
          className={cn('mt-0.5 size-4 shrink-0 transition-transform', open ? 'rotate-0' : '-rotate-90')}
        />
      </Button>

      {open ? (
        <div id={`tool-item-${message.id}`} className="space-y-2 px-2 pb-2 text-xs">
          <ToolItemContent
            inputData={inputData}
            output={output}
            isError={isError}
            readCode={readCode}
            editDiff={editDiff}
            message={message}
            askUserQuestionDisabled={askUserQuestionDisabled}
            onSubmitAskUserQuestion={onSubmitAskUserQuestion}
          />
        </div>
      ) : null}
    </div>
  )
})

const ChatToolGroupMessage = memo(function ChatToolGroupMessage({
  toolMessages,
  align,
  openById,
  onToggle,
  isActive,
  onSubmitAskUserQuestion,
  askUserQuestionDisabled,
}: {
  toolMessages: ChatMessage[]
  align: ChatAlign
  openById: OpenById
  onToggle: (id: string) => void
  isActive: boolean
  onSubmitAskUserQuestion?: (toolUseId: string, answers: Record<string, string>, messageId: string) => void
  askUserQuestionDisabled: boolean
}) {
  const groupId = useMemo(() => `msg-working-${toolMessages[0]?.id ?? randomId('working')}`, [toolMessages])
  const defaultOpen = isActive || toolMessages.length <= 3
  const open = openById[groupId] ?? defaultOpen
  const label = isActive ? 'Working' : 'Finished working'

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
          aria-controls={`working-${groupId}`}
          onClick={() => onToggle(groupId)}
        >
          <span className="inline-flex items-center gap-2">
            {isActive ? (
              <Spinner className="size-3" />
            ) : (
              <span className="inline-flex size-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                <Check className="size-3" />
              </span>
            )}
            <span>{label}</span>
          </span>
          <span className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
            {formatToolCallCount(toolMessages.length)}
            <ChevronDown className={cn('size-4 shrink-0 transition-transform', open ? 'rotate-0' : '-rotate-90')} />
          </span>
        </Button>

        {open ? (
          <div id={`working-${groupId}`} className="space-y-2 px-3 pb-3">
            {toolMessages.map((tool) => (
              <ChatToolCallItem
                key={tool.id}
                message={tool}
                openById={openById}
                onToggle={onToggle}
                onSubmitAskUserQuestion={onSubmitAskUserQuestion}
                askUserQuestionDisabled={askUserQuestionDisabled}
              />
            ))}
          </div>
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
  if (!showBubble && !message.images?.length && !tokenUsage) return null

  const markdown = message.role === 'agent' ? message.text : ''

  return (
    <ChatMessageRow align={align}>
      <div className="max-w-[80%]">
        {showBubble ? (
          <div
            className={cn(
              'rounded-lg px-3 py-2 text-sm break-words',
              message.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : message.role === 'agent'
                  ? 'bg-muted text-foreground'
                  : 'bg-accent text-accent-foreground',
            )}
          >
            {message.text ? (
              message.role === 'agent' ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  components={{
                    p: ({ children }) => (
                      <p className="whitespace-pre-wrap leading-relaxed">{children}</p>
                    ),
                    h1: ({ children }) => (
                      <h1 className="text-lg font-semibold leading-snug">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-base font-semibold leading-snug">{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="text-sm font-semibold leading-snug">{children}</h3>
                    ),
                    ul: ({ children }) => <ul className="ml-5 list-disc space-y-1">{children}</ul>,
                    ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1">{children}</ol>,
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    a: ({ href, children }) => (
                      <a
                        href={href ?? '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline underline-offset-2 hover:opacity-90"
                      >
                        {children}
                      </a>
                    ),
                    code: ({ className, children, ...props }) => (
                      <code
                        {...props}
                        className={cn(
                          'rounded bg-background/60 px-1 py-0.5 font-mono text-[0.85em]',
                          className,
                        )}
                      >
                        {children}
                      </code>
                    ),
                    pre: ({ children }) => {
                      const first = Array.isArray(children) ? children[0] : children
                      if (isValidElement(first)) {
                        const props = first.props as { className?: unknown; children?: unknown }
                        const className = typeof props.className === 'string' ? props.className : ''
                        const match = /language-([a-z0-9_-]+)/i.exec(className)
                        const language = match?.[1]

                        const raw = Array.isArray(props.children)
                          ? props.children.map((c) => String(c ?? '')).join('')
                          : String(props.children ?? '')
                        const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw

                        return (
                          <div className="my-2 overflow-hidden rounded-md border bg-background">
                            <ShikiCode code={text} language={language} className="max-h-[360px]" />
                          </div>
                        )
                      }

                      return (
                        <pre className="my-2 overflow-auto rounded-md border bg-background p-3 text-xs">
                          {children}
                        </pre>
                      )
                    },
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-2 border-border/70 pl-3 text-muted-foreground">
                        {children}
                      </blockquote>
                    ),
                    hr: () => <div className="my-2 h-px bg-border/70" />,
                  }}
                >
                  {markdown}
                </ReactMarkdown>
              ) : (
                message.text
              )
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
  onSubmitAskUserQuestion,
  askUserQuestionDisabled,
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
  onSubmitAskUserQuestion?: (
    toolUseId: string,
    answers: Record<string, string>,
    messageId: string,
  ) => void
  askUserQuestionDisabled: boolean
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
      {(() => {
        const rows: ReactNode[] = []

        for (let i = 0; i < messages.length; i += 1) {
          const m = messages[i]
          const align: ChatAlign = m.role === 'user' ? 'justify-end' : 'justify-start'
          const isActiveAgentMessage =
            Boolean(sending && activeTaskId) && m.id === `msg-agent-${activeTaskId}`
          const isActiveThinkMessage =
            Boolean(sending && activeTaskId && activeReasoningMessageId) &&
            m.kind === 'think' &&
            m.id === activeReasoningMessageId

          if (m.kind === 'think') {
            const open = thinkOpenById[m.id] ?? isActiveThinkMessage
            rows.push(
              <ChatThinkMessage
                key={m.id}
                message={m}
                align={align}
                open={open}
                isActive={isActiveThinkMessage}
                onToggle={toggleThinkOpen}
              />,
            )
            continue
          }

          if (m.kind === 'tool' && m.role === 'agent') {
            const toolMessages: ChatMessage[] = [m]
            let j = i + 1
            while (
              j < messages.length &&
              messages[j].kind === 'tool' &&
              messages[j].role === 'agent'
            ) {
              toolMessages.push(messages[j])
              j += 1
            }

            const isActiveGroup = Boolean(sending && activeTaskId) && j === messages.length

            rows.push(
              <ChatToolGroupMessage
                key={`working-${toolMessages[0].id}`}
                toolMessages={toolMessages}
                align={align}
                openById={toolOpenById}
                onToggle={toggleToolOpen}
                isActive={isActiveGroup}
                onSubmitAskUserQuestion={onSubmitAskUserQuestion}
                askUserQuestionDisabled={askUserQuestionDisabled}
              />,
            )

            i = j - 1
            continue
          }

          const tokenUsage = m.role === 'agent' ? tokenByMessageId[m.id] : undefined
          rows.push(
            <ChatTextMessage
              key={m.id}
              message={m}
              align={align}
              isActiveAgentMessage={isActiveAgentMessage}
              tokenUsage={tokenUsage}
            />,
          )
        }

        return rows
      })()}
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

function upsertThinkMessage(
  prev: ChatMessage[],
  thinkMessageId: string,
  agentMessageId: string,
  thinkText: string,
): ChatMessage[] {
  const existingIndex = prev.findIndex((m) => m.id === thinkMessageId)
  if (existingIndex >= 0) {
    const existing = prev[existingIndex]
    if (existing.text === thinkText) return prev
    const next = [...prev]
    next[existingIndex] = { ...existing, text: thinkText }
    return next
  }

  const insertIndex = prev.findIndex((m) => m.id === agentMessageId)
  const next = [...prev]
  const message: ChatMessage = { id: thinkMessageId, role: 'agent', kind: 'think', text: thinkText }
  if (insertIndex >= 0) {
    next.splice(insertIndex, 0, message)
  } else {
    next.push(message)
  }
  return next
}

function extractInlineThinkForMessage(
  messages: ChatMessage[],
  agentMessageId: string,
): { messages: ChatMessage[]; thinkMessageId: string } | null {
  const targetIndex = messages.findIndex(
    (m) => m.id === agentMessageId && m.role === 'agent' && m.kind === 'text',
  )
  if (targetIndex < 0) return null

  const target = messages[targetIndex]
  const inlineThink = extractInlineThink(target.text)
  if (!inlineThink) return null

  const thinkMessageId = getInlineThinkId(agentMessageId)
  let next = upsertThinkMessage(messages, thinkMessageId, agentMessageId, inlineThink.thinkText)

  const updatedIndex = next.findIndex((m) => m.id === agentMessageId)
  if (updatedIndex >= 0) {
    const updated = next[updatedIndex]
    next = [...next]
    next[updatedIndex] = { ...updated, text: inlineThink.visibleText }
  }

  return { messages: next, thinkMessageId }
}

function splitInlineThinkMessages(
  messages: ChatMessage[],
): { messages: ChatMessage[]; thinkIds: string[] } {
  const next: ChatMessage[] = []
  const thinkIds: string[] = []

  for (const message of messages) {
    if (message.role === 'agent' && message.kind === 'text') {
      const inlineThink = extractInlineThink(message.text)
      if (inlineThink) {
        const thinkMessageId = getInlineThinkId(message.id)
        next.push({ id: thinkMessageId, role: 'agent', kind: 'think', text: inlineThink.thinkText })
        thinkIds.push(thinkMessageId)
        next.push({ ...message, text: inlineThink.visibleText })
        continue
      }
    }

    next.push(message)
  }

  return { messages: next, thinkIds }
}

function insertAfterMessage(
  prev: ChatMessage[],
  anchorMessageId: string | null | undefined,
  message: ChatMessage,
): ChatMessage[] {
  if (!anchorMessageId) return [...prev, message]
  const insertIndex = prev.findIndex((m) => m.id === anchorMessageId)
  const next = [...prev]
  if (insertIndex >= 0) {
    next.splice(insertIndex + 1, 0, message)
  } else {
    next.push(message)
  }
  return next
}

function findLastConsecutiveToolIdAfter(messages: ChatMessage[], anchorMessageId: string): string | null {
  const anchorIndex = messages.findIndex((m) => m.id === anchorMessageId)
  if (anchorIndex < 0) return null

  let tailId: string | null = null
  for (let i = anchorIndex + 1; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role === 'agent' && message.kind === 'tool') {
      tailId = message.id
      continue
    }
    break
  }

  return tailId
}

export function ProjectChat({
  project,
  detailsOpen,
  detailsPortalTarget,
  activeFilePath,
  codeSelection,
  onClearCodeSelection,
  onToolOutput,
  currentToolType,
  sessionId,
}: {
  project: ProjectDto
  detailsOpen: boolean
  detailsPortalTarget: HTMLDivElement | null
  activeFilePath?: string | null
  codeSelection?: CodeSelection | null
  onClearCodeSelection?: () => void
  onToolOutput?: (chunk: string) => void
  currentToolType?: 'Codex' | 'ClaudeCode' | null
  sessionId?: string | null
}) {
  const apiBase = useMemo(() => getApiBase(), [])
  const sessionIdRef = useRef<string>(sessionId ?? createUuid())
  const workspacePath = project.workspacePath.trim()
  const routeTool = useRouteTool()

  useEffect(() => {
    if (sessionId) {
      sessionIdRef.current = sessionId
    }
  }, [sessionId])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyCursor, setHistoryCursor] = useState<number | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyInitialized, setHistoryInitialized] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<DraftImage[]>([])
  const [todoDockOpen, setTodoDockOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [activeReasoningMessageId, setActiveReasoningMessageId] = useState<string | null>(
    null,
  )
  const [canceling, setCanceling] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [toolOutput, setToolOutput] = useState('')
  const [providers, setProviders] = useState<ProviderDto[]>([])
  const [providersLoaded, setProvidersLoaded] = useState(false)
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null)
  const [customModels, setCustomModels] = useState<string[]>([])
  const [customModelsLoaded, setCustomModelsLoaded] = useState(false)
  const [customModelsLoadedKey, setCustomModelsLoadedKey] = useState<string | null>(null)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [addModelProviderId, setAddModelProviderId] = useState('')
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
  const suppressAutoScrollRef = useRef(false)
  const historyLoadingRef = useRef(false)
  const composerOverlayRef = useRef<HTMLDivElement | null>(null)
  const [composerOverlayHeightPx, setComposerOverlayHeightPx] = useState(0)
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelPickerQuery, setModelPickerQuery] = useState('')
  const modelPickerSearchRef = useRef<HTMLInputElement | null>(null)
  const [customModelsByProvider, setCustomModelsByProvider] = useState<Record<string, string[]>>({})

  const modelSelectionStorageKey = useMemo(() => {
    return `onecode:chat:model-selection:v2:${project.id}`
  }, [project.id])

  const legacyModelOverrideStorageKey = useMemo(() => {
    return `onecode:chat:model-override:v1:${project.id}`
  }, [project.id])

  const activeProviderId = useMemo(() => {
    return modelSelection?.providerId ?? project.providerId ?? null
  }, [modelSelection?.providerId, project.providerId])

  const customModelStorageKey = useMemo(() => {
    const providerKey = activeProviderId ?? 'default'
    return `onecode:chat:custom-models:v1:${project.toolType}:${providerKey}`
  }, [activeProviderId, project.toolType])

  const activeProvider = useMemo(() => {
    if (!activeProviderId) return null
    return providers.find((p) => p.id === activeProviderId) ?? null
  }, [activeProviderId, providers])

  const modelPickerQueryKey = useMemo(() => {
    return modelPickerQuery.trim().toLowerCase()
  }, [modelPickerQuery])

  const modelPickerProviderGroups = useMemo(() => {
    if (!providersLoaded) return []

    const query = modelPickerQueryKey

    return providers
      .map((p) => {
        const providerName = (p.name ?? '').trim()
        const providerMatches = query ? providerName.toLowerCase().includes(query) : false

        const rawCustomModels =
          customModelsByProvider[p.id] ??
          (p.id === activeProviderId && customModelsLoaded ? customModels : [])

        const customDeduped = rawCustomModels.filter(
          (m) => !p.models.some((existing) => existing.toLowerCase() === m.toLowerCase()),
        )

        const matchesQuery = (m: string) =>
          !query || providerMatches || m.toLowerCase().includes(query)

        const models = p.models.filter(matchesQuery)
        const custom = customDeduped.filter(matchesQuery)

        const showGroup = !query || providerMatches || models.length > 0 || custom.length > 0

        return { provider: p, models, customModels: custom, showGroup }
      })
      .filter((g) => g.showGroup)
  }, [
    activeProviderId,
    customModels,
    customModelsByProvider,
    customModelsLoaded,
    modelPickerQueryKey,
    project.toolType,
    providers,
    providersLoaded,
  ])

  useEffect(() => {
    if (!scrollRef.current) return
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false
      return
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const scrollBottomPaddingPx = useMemo(() => {
    const fallback = 160
    const measured = Math.round(composerOverlayHeightPx) + 16
    return Math.max(fallback, measured)
  }, [composerOverlayHeightPx])

  useEffect(() => {
    const overlay = composerOverlayRef.current
    if (!overlay) return

    const update = () => {
      const next = Math.max(0, Math.round(overlay.getBoundingClientRect().height))
      setComposerOverlayHeightPx((prev) => (prev === next ? prev : next))
    }

    update()

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => update())
    ro.observe(overlay)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
    if (remaining < 64) {
      el.scrollTop = el.scrollHeight
    }
  }, [scrollBottomPaddingPx])

  const mapSessionMessage = useCallback((message: ProjectSessionMessageDto): ChatMessage => {
    const roleRaw = (message.role ?? '').toLowerCase()
    const kindRaw = (message.kind ?? '').toLowerCase()
    const role: ChatRole =
      roleRaw === 'user' ? 'user' : roleRaw === 'system' ? 'system' : 'agent'
    const kind: ChatMessageKind =
      kindRaw === 'tool' ? 'tool' : kindRaw === 'think' ? 'think' : 'text'

    const fingerprint = [
      role,
      kind,
      message.timestampUtc ?? '',
      message.toolUseId ?? '',
      message.toolName ?? '',
      message.toolInput ?? '',
      message.toolOutput ?? '',
      message.toolIsError ? '1' : '0',
      normalizeNewlines(message.text ?? ''),
    ].join('|')
    const id = `history-${hashString(fingerprint)}`

    const next: ChatMessage = {
      id,
      role,
      kind,
      text: message.text ?? '',
    }

    if (message.toolName) next.toolName = message.toolName
    if (message.toolUseId) next.toolUseId = message.toolUseId
    if (message.toolInput) next.toolInput = message.toolInput
    if (message.toolOutput) next.toolOutput = message.toolOutput
    if (message.toolIsError) next.toolIsError = message.toolIsError

    return next
  }, [])

  const loadSessionMessages = useCallback(
    async (opts?: { before?: number | null; prepend?: boolean }) => {
      if (!sessionId) return
      if (historyLoadingRef.current) return

      historyLoadingRef.current = true
      setHistoryLoading(true)
      setHistoryError(null)

      const before = opts?.before ?? null
      const prepend = Boolean(opts?.prepend)
      const scrollSnapshot =
        prepend && scrollRef.current
          ? {
              height: scrollRef.current.scrollHeight,
              top: scrollRef.current.scrollTop,
            }
          : null

      try {
        const page = await api.projects.sessionMessages(project.id, sessionId, {
          before: before ?? undefined,
          limit: sessionHistoryPageSize,
        })
        const mapped = page.messages.map(mapSessionMessage)
        const uniqueMap = new Map<string, ChatMessage>()
        for (const msg of mapped) {
          if (!uniqueMap.has(msg.id)) uniqueMap.set(msg.id, msg)
        }
        const deduped = Array.from(uniqueMap.values())
        const { messages: dedupedWithThink, thinkIds: dedupedThinkIds } =
          splitInlineThinkMessages(deduped)

        let insertedThinkIds: string[] = []
        if (prepend) {
          if (dedupedWithThink.length) {
            suppressAutoScrollRef.current = true
            setMessages((prev) => {
              if (!prev.length) {
                insertedThinkIds = dedupedThinkIds
                return dedupedWithThink
              }
              const existing = new Set(prev.map((m) => m.id))
              const unique = dedupedWithThink.filter((m) => !existing.has(m.id))
              if (unique.length) {
                const newThinkIds = dedupedThinkIds.filter((id) =>
                  unique.some((m) => m.id === id),
                )
                if (newThinkIds.length) insertedThinkIds = newThinkIds
              }
              return unique.length ? [...unique, ...prev] : prev
            })
          }
        } else {
          setMessages(dedupedWithThink)
          insertedThinkIds = dedupedThinkIds
        }

        if (insertedThinkIds.length) {
          setThinkOpenById((prev) => {
            const next = { ...prev }
            let changed = false
            for (const id of insertedThinkIds) {
              if (next[id] === undefined) {
                next[id] = true
                changed = true
              }
            }
            return changed ? next : prev
          })
        }

        setHistoryCursor(page.nextCursor ?? null)
        setHistoryHasMore(page.hasMore)
        setHistoryInitialized(true)

        if (prepend && scrollSnapshot && typeof window !== 'undefined') {
          window.requestAnimationFrame(() => {
            const el = scrollRef.current
            if (!el) return
            const delta = el.scrollHeight - scrollSnapshot.height
            el.scrollTop = scrollSnapshot.top + delta
          })
        }
      } catch (e) {
        setHistoryError((e as Error).message)
      } finally {
        historyLoadingRef.current = false
        setHistoryLoading(false)
      }
    },
    [mapSessionMessage, project.id, sessionId, setThinkOpenById],
  )

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (!sessionId) return
    if (!historyHasMore || historyCursor == null) return
    if (historyLoadingRef.current) return
    if (el.scrollTop > sessionHistoryLoadThresholdPx) return

    void loadSessionMessages({ before: historyCursor, prepend: true })
  }, [historyCursor, historyHasMore, loadSessionMessages, sessionId])

  useEffect(() => {
    if (!sessionId) {
      setHistoryCursor(null)
      setHistoryHasMore(false)
      setHistoryError(null)
      setHistoryLoading(false)
      setHistoryInitialized(false)
      return
    }

    setMessages([])
    setThinkOpenById({})
    setToolOpenById({})
    setTokenByMessageId({})
    setHistoryCursor(null)
    setHistoryHasMore(false)
    setHistoryError(null)
    setHistoryInitialized(false)
    historyLoadingRef.current = false

    void loadSessionMessages()
  }, [loadSessionMessages, sessionId])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      setModelSelection(null)

      const raw = window.localStorage.getItem(modelSelectionStorageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as { providerId?: unknown; model?: unknown }
          const providerId = typeof obj.providerId === 'string' ? obj.providerId.trim() : ''
          const model = typeof obj.model === 'string' ? obj.model.trim() : ''
          if (providerId && model) {
            setModelSelection({ providerId, model })
            return
          }
        }
      }

      const legacyRaw = window.localStorage.getItem(legacyModelOverrideStorageKey) ?? ''
      const legacyModel = legacyRaw.trim()
      if (legacyModel && project.providerId) {
        setModelSelection({ providerId: project.providerId, model: legacyModel })
      }
    } catch {
      // ignore
    }
  }, [
    legacyModelOverrideStorageKey,
    modelSelectionStorageKey,
    project.providerId,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      if (!modelSelection) {
        window.localStorage.removeItem(modelSelectionStorageKey)
      } else {
        window.localStorage.setItem(modelSelectionStorageKey, JSON.stringify(modelSelection))
      }

      window.localStorage.removeItem(legacyModelOverrideStorageKey)
    } catch {
      // ignore
    }
  }, [
    legacyModelOverrideStorageKey,
    modelSelection,
    modelSelectionStorageKey,
  ])

  useEffect(() => {
    if (!modelPickerOpen) return
    if (typeof window === 'undefined') return

    const timer = window.setTimeout(() => {
      modelPickerSearchRef.current?.focus()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [modelPickerOpen])

  useEffect(() => {
    if (!modelPickerOpen) {
      setCustomModelsByProvider({})
      return
    }
    if (typeof window === 'undefined') return

    const next: Record<string, string[]> = {}
    for (const provider of providers) {
      const customKey = `onecode:chat:custom-models:v1:${project.toolType}:${provider.id}`
      try {
        const raw = window.localStorage.getItem(customKey)
        if (!raw) continue
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) continue

        next[provider.id] = parsed
          .filter((m): m is string => typeof m === 'string')
          .map((m) => m.trim())
          .filter(Boolean)
      } catch {
        // ignore
      }
    }

    setCustomModelsByProvider(next)
  }, [modelPickerOpen, project.toolType, providers])

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

  const preferClaudeProviders = useMemo(() => {
    if (routeTool.isClaudeRoute) return true
    if (routeTool.isCodexRoute) return false
    return (currentToolType ?? project.toolType) === 'ClaudeCode'
  }, [
    currentToolType,
    project.toolType,
    routeTool.isClaudeRoute,
    routeTool.isCodexRoute,
  ])

  useEffect(() => {
    setProviders([])
    setProvidersLoaded(false)

    let canceled = false
    void (async () => {
      try {
        const allProviders = await api.providers.list()
        if (canceled) return
        if (preferClaudeProviders) {
          setProviders(allProviders.filter((p) => p.requestType === 'Anthropic'))
        } else {
          setProviders(allProviders.filter((p) => p.requestType !== 'Anthropic'))
        }
      } catch {
        if (!canceled) setProviders([])
      } finally {
        if (!canceled) setProvidersLoaded(true)
      }
    })()

    return () => {
      canceled = true
    }
  }, [preferClaudeProviders])

  useEffect(() => {
    setCustomModels([])
    setCustomModelsLoaded(false)
    setCustomModelsLoadedKey(null)

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
      setCustomModelsLoadedKey(customModelStorageKey)
    }
  }, [customModelStorageKey])

  useEffect(() => {
    const customModelsReady =
      customModelsLoaded && customModelsLoadedKey === customModelStorageKey
    const optionsLoaded = providersLoaded && customModelsReady
    if (!optionsLoaded) return

    if (!modelSelection) return

    const provider = providers.find((p) => p.id === modelSelection.providerId) ?? null
    if (!provider) {
      setModelSelection(null)
      return
    }

    const map = new Map<string, string>()
    for (const m of provider.models) map.set(m.toLowerCase(), m)
    for (const m of customModels) map.set(m.toLowerCase(), m)

    const normalized = map.get(modelSelection.model.toLowerCase()) ?? null
    if (!normalized) {
      setModelSelection(null)
      return
    }

    if (normalized !== modelSelection.model) {
      setModelSelection({ ...modelSelection, model: normalized })
    }
  }, [
    customModelStorageKey,
    customModels,
    customModelsLoaded,
    customModelsLoadedKey,
    modelSelection,
    providers,
    providersLoaded,
  ])

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

  const updateMessageText = useCallback(
    (messageId: string, updater: (prev: string) => string) => {
      let newThinkId: string | null = null
      setMessages((prev) => {
        const next = prev.map((m) => (m.id === messageId ? { ...m, text: updater(m.text) } : m))
        const extraction = extractInlineThinkForMessage(next, messageId)
        if (!extraction) return next

        newThinkId = extraction.thinkMessageId
        return extraction.messages
      })

      if (newThinkId) {
        const thinkId = newThinkId
        setThinkOpenById((prev) =>
          prev[thinkId] !== undefined ? prev : { ...prev, [thinkId]: true },
        )
      }
    },
    [setThinkOpenById],
  )

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
    setAddModelProviderId(activeProviderId ?? '')
    setAddModelDraft('')
    setAddModelError(null)
    setAddModelOpen(true)
  }, [activeProviderId])

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

  const todoDockInput = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role !== 'agent' || message.kind !== 'tool') continue
      const toolName = (message.toolName ?? '').trim()
      if (!toolName || !isTodoWriteToolName(toolName)) continue

      const input = message.toolInput ?? message.text ?? ''
      const parsed = tryParseTodoWriteToolInput(input)
      if (parsed && parsed.todos.length) return parsed
      return null
    }

    return null
  }, [messages])

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
    const seenCodexAgentMessages = new Set<string>()
    const toolMessageIdByUseId = new Map<string, string>()
    const toolNameByUseId = new Map<string, string>()
    const seenClaudeToolResultChunks = new Set<string>()
    const toolOutputMessageId = `msg-tool-output-${taskId}`
    let sawFinal = false
    const isClaude = project.toolType === 'ClaudeCode'
    let activeAgentTextMessageId = agentMessageId
    let agentTextSegmentIndex = 1
    let sawAnyAgentText = false
    let toolChainTailMessageId: string | null = null
    let startNewTextSegmentAfterTools = false

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
          ...(modelSelection
            ? { model: modelSelection.model, providerId: modelSelection.providerId }
            : {}),
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
            if (isClaude) {
              if (statusUpdate.final) {
                if (!sawAnyAgentText) {
                  if (startNewTextSegmentAfterTools && toolChainTailMessageId) {
                    agentTextSegmentIndex += 1
                    const nextTextId = `${agentMessageId}-seg-${agentTextSegmentIndex}`
                    const insertAfterId = toolChainTailMessageId

                    activeAgentTextMessageId = nextTextId
                    sawAnyAgentText = true
                    startNewTextSegmentAfterTools = false
                    toolChainTailMessageId = null

                    const toolMessage: ChatMessage = {
                      id: nextTextId,
                      role: 'agent',
                      kind: 'text',
                      text: chunk,
                    }

                    setMessages((prev) => {
                      const existingIndex = prev.findIndex((m) => m.id === nextTextId)
                      if (existingIndex >= 0) {
                        const next = [...prev]
                        const existing = next[existingIndex]
                        next[existingIndex] = { ...existing, text: existing.text + chunk }
                        return next
                      }

                      return insertAfterMessage(prev, insertAfterId, toolMessage)
                    })
                  } else {
                    updateMessageText(activeAgentTextMessageId, () => chunk)
                    sawAnyAgentText = true
                  }
                }
              } else if (startNewTextSegmentAfterTools && toolChainTailMessageId) {
                agentTextSegmentIndex += 1
                const nextTextId = `${agentMessageId}-seg-${agentTextSegmentIndex}`
                const insertAfterId = toolChainTailMessageId

                activeAgentTextMessageId = nextTextId
                sawAnyAgentText = true
                startNewTextSegmentAfterTools = false
                toolChainTailMessageId = null

                const toolMessage: ChatMessage = {
                  id: nextTextId,
                  role: 'agent',
                  kind: 'text',
                  text: chunk,
                }

                setMessages((prev) => {
                  const existingIndex = prev.findIndex((m) => m.id === nextTextId)
                  if (existingIndex >= 0) {
                    const next = [...prev]
                    const existing = next[existingIndex]
                    next[existingIndex] = { ...existing, text: existing.text + chunk }
                    return next
                  }

                  return insertAfterMessage(prev, insertAfterId, toolMessage)
                })
              } else {
                updateMessageText(activeAgentTextMessageId, (prev) => prev + chunk)
                sawAnyAgentText = true
                if (toolChainTailMessageId) {
                  toolChainTailMessageId = null
                }
              }
            } else {
              if (startNewTextSegmentAfterTools && toolChainTailMessageId) {
                agentTextSegmentIndex += 1
                const nextTextId = `${agentMessageId}-seg-${agentTextSegmentIndex}`
                const insertAfterId = toolChainTailMessageId

                activeAgentTextMessageId = nextTextId
                sawAnyAgentText = true
                startNewTextSegmentAfterTools = false
                toolChainTailMessageId = null

                const toolMessage: ChatMessage = {
                  id: nextTextId,
                  role: 'agent',
                  kind: 'text',
                  text: chunk,
                }

                setMessages((prev) => {
                  const existingIndex = prev.findIndex((m) => m.id === nextTextId)
                  if (existingIndex >= 0) {
                    const next = [...prev]
                    const existing = next[existingIndex]
                    next[existingIndex] = { ...existing, text: existing.text + chunk }
                    return next
                  }

                  return insertAfterMessage(prev, insertAfterId, toolMessage)
                })
              } else {
                if (statusUpdate.final) {
                  updateMessageText(activeAgentTextMessageId, () => chunk)
                } else {
                  updateMessageText(activeAgentTextMessageId, (prev) => prev + chunk)
                }
                sawAnyAgentText = true
                if (toolChainTailMessageId) {
                  toolChainTailMessageId = null
                }
              }
            }
          }
        }

        if (statusUpdate?.final) {
          sawFinal = true
          setSending(false)
          setActiveReasoningMessageId(null)
          setActiveTaskId(null)
          setCanceling(false)
        }

        const artifactUpdate = (resultObj.artifactUpdate ?? null) as A2aArtifactUpdate | null
        const artifact = artifactUpdate?.artifact
        const artifactName = artifact?.name ?? ''

        if (!isClaude && artifactName === 'tool-output') {
          const parts = (artifact?.parts ?? []) as unknown[]
          const chunk = readPartsText(parts)
          if (chunk) {
            const trimmed = chunk.trim()
            if (
              trimmed.startsWith('@[') &&
              trimmed.endsWith(']') &&
              trimmed.toLowerCase().includes('image')
            ) {
              continue
            }

            setToolOutput((prev) => prev + chunk)
            onToolOutput?.(chunk)

            const anchorToolId = toolChainTailMessageId
            if (anchorToolId) {
              setToolOpenById((prev) =>
                prev[anchorToolId] !== undefined ? prev : { ...prev, [anchorToolId]: true },
              )

              setMessages((prev) => {
                const existingIndex = prev.findIndex((m) => m.id === anchorToolId)
                if (existingIndex < 0) return prev

                const next = [...prev]
                const existing = next[existingIndex]
                next[existingIndex] = {
                  ...existing,
                  toolOutput: (existing.toolOutput ?? '') + chunk,
                }
                return next
              })

              continue
            }

            setToolOpenById((prev) =>
              prev[toolOutputMessageId] !== undefined
                ? prev
                : { ...prev, [toolOutputMessageId]: true },
            )

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
            const tokenMessageId = isClaude ? activeAgentTextMessageId : agentMessageId
            setTokenByMessageId((prev) => ({
              ...prev,
              [tokenMessageId]: normalized,
            }))
            break
          }
          continue
        }

        if (artifactName === 'claude-tools') {
          const parts = (artifact?.parts ?? []) as unknown[]
          for (const part of parts) {
            if (!part || typeof part !== 'object') continue
            const dataValue = (part as { data?: unknown }).data
            if (!dataValue || typeof dataValue !== 'object') continue

            const dataObj = dataValue as {
              kind?: unknown
              toolUseId?: unknown
              toolName?: unknown
              input?: unknown
              output?: unknown
              isError?: unknown
            }

            const kind = String(dataObj.kind ?? '').trim()
            const toolUseId = String(dataObj.toolUseId ?? '').trim()
            if (!kind || !toolUseId) continue

            const toolName = typeof dataObj.toolName === 'string' ? dataObj.toolName : undefined
            const input =
              typeof dataObj.input === 'string'
                ? dataObj.input
                : dataObj.input != null
                  ? stringifyToolArgs(dataObj.input)
                  : ''
            const output =
              typeof dataObj.output === 'string'
                ? dataObj.output
                : dataObj.output != null
                  ? stringifyToolArgs(dataObj.output)
                  : ''
            const isError = dataObj.isError === true

            const ensureToolMessageId = () => {
              const existing = toolMessageIdByUseId.get(toolUseId)
              if (existing) return existing
              const created = `msg-claude-tool-${taskId}-${toolUseId}`
              toolMessageIdByUseId.set(toolUseId, created)
              return created
            }

            if (kind === 'tool_use') {
              const toolMessageId = ensureToolMessageId()
              const resolvedToolName = toolName ?? 'tool'
              toolNameByUseId.set(toolUseId, resolvedToolName)
              const toolMessage: ChatMessage = {
                id: toolMessageId,
                role: 'agent',
                kind: 'tool',
                toolName: resolvedToolName,
                toolUseId,
                toolInput: input,
                text: input,
              }

              const chainTailId: string | null = toolChainTailMessageId
              const textAnchorId = activeAgentTextMessageId
              const pinTaskToChainHead: boolean =
                Boolean(chainTailId) &&
                isTaskToolName(resolvedToolName) &&
                /subagent_type|subagentType/i.test(input)

              if (!chainTailId) {
                startNewTextSegmentAfterTools = true
              }

              toolChainTailMessageId = pinTaskToChainHead ? (chainTailId as string) : toolMessageId

              setToolOpenById((prev) =>
                prev[toolMessageId] !== undefined
                  ? prev
                  : { ...prev, [toolMessageId]: shouldAutoOpenClaudeTool(resolvedToolName) },
              )

              setMessages((prev) => {
                const existingIndex = prev.findIndex((m) => m.id === toolMessageId)
                if (existingIndex >= 0) {
                  const next = [...prev]
                  const existing = next[existingIndex]
                  const existingInput = existing.toolInput ?? existing.text ?? ''
                  const mergedInput = mergeStreamingToolText(existingInput, input)
                  next[existingIndex] = {
                    ...existing,
                    toolName: toolMessage.toolName,
                    toolUseId,
                    toolInput: mergedInput,
                    text: mergedInput,
                  }
                  return next
                }

                const tailIndex = chainTailId ? prev.findIndex((m) => m.id === chainTailId) : -1
                const anchorAfterId =
                  pinTaskToChainHead
                    ? textAnchorId
                    : tailIndex >= 0
                    ? (chainTailId as string)
                    : findLastConsecutiveToolIdAfter(prev, textAnchorId) ?? textAnchorId

                return insertAfterMessage(prev, anchorAfterId, toolMessage)
              })

              activeThinkMessageId = null
              setActiveReasoningMessageId(null)
              continue
            }

            if (kind === 'tool_result') {
              const toolMessageId = ensureToolMessageId()
              const resolvedToolName = toolName ?? toolNameByUseId.get(toolUseId) ?? 'tool'
              const chainTailId: string | null = toolChainTailMessageId
              const textAnchorId = activeAgentTextMessageId
              const pinTaskToChainHead: boolean = Boolean(chainTailId) && isTaskToolName(resolvedToolName)
              if (!chainTailId) {
                startNewTextSegmentAfterTools = true
              }
              toolChainTailMessageId = pinTaskToChainHead ? (chainTailId as string) : toolMessageId

              setToolOpenById((prev) =>
                prev[toolMessageId] !== undefined
                  ? prev
                  : { ...prev, [toolMessageId]: shouldAutoOpenClaudeTool(resolvedToolName) },
              )

              setMessages((prev) => {
                const existingIndex = prev.findIndex((m) => m.id === toolMessageId)
                if (existingIndex >= 0) {
                  const next = [...prev]
                  const existing = next[existingIndex]
                  const mergedOutput = existing.toolOutput
                    ? output && !existing.toolOutput.includes(output)
                      ? `${existing.toolOutput}\n\n${output}`
                      : existing.toolOutput
                    : output
                  next[existingIndex] = {
                    ...existing,
                    toolUseId,
                    toolOutput: mergedOutput,
                    toolIsError: isError || existing.toolIsError,
                  }
                  return next
                }

                const toolMessage: ChatMessage = {
                  id: toolMessageId,
                  role: 'agent',
                  kind: 'tool',
                  toolName: resolvedToolName,
                  toolUseId,
                  toolOutput: output,
                  toolIsError: isError,
                  text: '',
                }

                const tailIndex = chainTailId ? prev.findIndex((m) => m.id === chainTailId) : -1
                const anchorAfterId =
                  pinTaskToChainHead
                    ? textAnchorId
                    : tailIndex >= 0
                    ? (chainTailId as string)
                    : findLastConsecutiveToolIdAfter(prev, textAnchorId) ?? textAnchorId

                return insertAfterMessage(prev, anchorAfterId, toolMessage)
              })

              if (output) {
                const dedupeKey = `${toolUseId}\n${output.slice(0, 512)}`
                if (!seenClaudeToolResultChunks.has(dedupeKey)) {
                  seenClaudeToolResultChunks.add(dedupeKey)
                  const formatted = `[${resolvedToolName}]\n${output}\n`
                  setToolOutput((prev) => {
                    const base = prev ?? ''
                    const separator = base && !base.endsWith('\n') ? '\n' : ''
                    return base + separator + formatted
                  })
                  onToolOutput?.(formatted)
                }
              }

              activeThinkMessageId = null
              setActiveReasoningMessageId(null)
              continue
            }
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
            if (isClaude) continue

            const toolCall = tryExtractCodexToolCall(raw, method)
            if (toolCall) {
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
                toolUseId: toolCall.callId,
                toolInput: toolCall.toolArgs,
                text: toolCall.toolArgs,
              }

              const shouldOpenTool = isAskUserQuestionToolName(toolCall.toolName)
              setToolOpenById((prev) =>
                prev[toolMessageId] !== undefined
                  ? prev
                  : { ...prev, [toolMessageId]: shouldOpenTool },
              )

              const chainTailId: string | null = toolChainTailMessageId
              const textAnchorId = activeAgentTextMessageId
              if (!chainTailId) {
                startNewTextSegmentAfterTools = true
              }
              toolChainTailMessageId = toolMessageId

              setMessages((prev) => {
                const tailIndex = chainTailId ? prev.findIndex((m) => m.id === chainTailId) : -1
                const anchorAfterId =
                  tailIndex >= 0
                    ? (chainTailId as string)
                    : findLastConsecutiveToolIdAfter(prev, textAnchorId) ?? textAnchorId
                return insertAfterMessage(prev, anchorAfterId, toolMessage)
              })

              // Split reasoning around tool boundaries so the timeline reads:
              // 思考 -> Tool -> 思考 -> Text
              activeThinkMessageId = null
              setActiveReasoningMessageId(null)
            }

            const agentMessage = tryExtractCodexAgentMessage(raw, method)
            if (!agentMessage?.text) continue

            const normalized = normalizeNewlines(agentMessage.text)
            const trimmed = normalized.trim()
            if (!trimmed) continue

            const agentDedupeKey = agentMessage.messageId
              ? `msg:${agentMessage.messageId}`
              : `text:${hashString(trimmed)}`
            if (seenCodexAgentMessages.has(agentDedupeKey)) continue
            seenCodexAgentMessages.add(agentDedupeKey)

            if (startNewTextSegmentAfterTools && toolChainTailMessageId) {
              agentTextSegmentIndex += 1
              const nextTextId = `${agentMessageId}-seg-${agentTextSegmentIndex}`
              const insertAfterId = toolChainTailMessageId

              activeAgentTextMessageId = nextTextId
              sawAnyAgentText = true
              startNewTextSegmentAfterTools = false
              toolChainTailMessageId = null

              const toolMessage: ChatMessage = {
                id: nextTextId,
                role: 'agent',
                kind: 'text',
                text: trimmed,
              }

              setMessages((prev) => {
                const existingIndex = prev.findIndex((m) => m.id === nextTextId)
                if (existingIndex >= 0) {
                  const next = [...prev]
                  const existing = next[existingIndex]
                  next[existingIndex] = { ...existing, text: mergeStreamingText(existing.text, trimmed) }
                  return next
                }

                return insertAfterMessage(prev, insertAfterId, toolMessage)
              })
            } else {
              updateMessageText(activeAgentTextMessageId, (prev) => mergeStreamingText(prev, trimmed))
              sawAnyAgentText = true
              if (toolChainTailMessageId) {
                toolChainTailMessageId = null
              }
            }
          }
        }

        if (!sawFinal) {
          setSending(false)
          setActiveReasoningMessageId(null)
          setActiveTaskId(null)
          setCanceling(false)
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
    modelSelection,
    onToolOutput,
    project.id,
    project.toolType,
    project.workspacePath,
    sending,
    updateMessageText,
  ])

  const submitAskUserQuestion = useCallback(
    async (toolUseId: string, answers: Record<string, string>, messageId: string) => {
      if (!activeTaskId) return
      if (!toolUseId) return

      const formatted = Object.entries(answers)
        .map(([question, answer]) => `"${question}"="${answer}"`)
        .join(', ')

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                toolIsError: false,
                toolOutput: formatted ? `User answers: ${formatted}` : 'User answered.',
              }
            : m,
        ),
      )

      try {
        const request = {
          jsonrpc: '2.0',
          id: randomId('req'),
          method: 'tasks/submitAskUserQuestion',
          params: {
            id: activeTaskId,
            toolUseId,
            answers,
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
          throw new Error(payload?.error?.message ?? '提交失败')
        }
      } catch (e) {
        setChatError((e as Error).message)
      }
    },
    [activeTaskId, apiBase],
  )

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
        <section style={{
          height: '100%'
        }} className="relative min-w-0 flex-1 overflow-hidden flex flex-col">
        {chatError ? (
          <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {chatError}
          </div>
        ) : null}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 overflow-y-auto px-4 pt-6"
          style={{ paddingBottom: scrollBottomPaddingPx, scrollbarGutter: 'stable' }}
        >
          {messages.length ? null : sessionId && historyLoading ? null : (
            <div className="flex h-full min-h-[160px] items-center justify-center text-center">
              <div className="max-w-sm text-sm text-muted-foreground">
                在这里开始对话：输入问题或指令。
              </div>
            </div>
          )}

          {sessionId && historyLoading ? (
            <div className="mb-3 flex items-center justify-center text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Spinner className="size-3" /> 加载会话记录中…
              </span>
            </div>
          ) : null}

          {historyError ? (
            <div className="mb-3 text-xs text-destructive">
              加载会话记录失败：{historyError}
            </div>
          ) : null}

          {sessionId && historyInitialized && !historyHasMore && messages.length ? (
            <div className="mb-3 text-center text-[11px] text-muted-foreground">
              已加载全部记录
            </div>
          ) : null}

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
              onSubmitAskUserQuestion={submitAskUserQuestion}
              askUserQuestionDisabled={sending || !activeTaskId || canceling}
            />
          </div>

        <div
          ref={composerOverlayRef}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-card via-card/80 to-transparent px-4 pb-4 pt-10"
        >
          <div className="pointer-events-auto mx-auto max-w-3xl">
            <div className="relative rounded-lg border bg-background/80 p-1 shadow-lg backdrop-blur">
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
                            <Button
                              key={item.fullPath}
                              type="button"
                              className={cn(
                                'h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left',
                                idx === mentionActiveIndex
                                  ? 'bg-accent text-accent-foreground hover:bg-accent'
                                  : 'hover:bg-accent/50 hover:text-foreground',
                              )}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => applyMentionSuggestion(item.fullPath)}
                              variant="ghost"
                              size="sm"
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
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <div className="px-2 py-2 text-xs text-muted-foreground">未找到匹配文件</div>
                      )}
                    </div>
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  {todoDockInput?.todos.length ? (
                    <div className="px-1">
                      <button
                        type="button"
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-md border bg-background/60 px-2 py-1 text-left',
                          'hover:bg-accent/40',
                        )}
                        onClick={() => setTodoDockOpen((prev) => !prev)}
                        aria-expanded={todoDockOpen}
                      >
                        <span className="text-[11px] font-medium text-muted-foreground">TodoWrite</span>
                        <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                            {todoDockInput.todos.length}
                          </Badge>
                          <ChevronDown
                            className={cn(
                              'size-4 shrink-0 transition-transform',
                              todoDockOpen ? 'rotate-0' : '-rotate-90',
                            )}
                          />
                        </span>
                      </button>
                      {todoDockOpen ? (
                        <div className="mt-1 rounded-md border bg-background/60 p-1">
                          <ClaudeTodoWriteTool
                            input={todoDockInput}
                            showHeader={false}
                            showActiveForm={false}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {activeOpenFileBadge ? (
                    <div className="flex flex-wrap gap-1.5 px-1">
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="ml-auto size-6 rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setIncludeActiveFileInPrompt((prev) => !prev)}
                          title={includeActiveFileInPrompt ? '点击后不加入提示词' : '点击后加入提示词'}
                          aria-label={
                            includeActiveFileInPrompt ? '点击后不加入提示词' : '点击后加入提示词'
                          }
                          aria-pressed={includeActiveFileInPrompt}
                        >
                          {includeActiveFileInPrompt ? (
                            <Eye className="size-3" />
                          ) : (
                            <EyeOff className="size-3" />
                          )}
                        </Button>
                      </Badge>
                    </div>
                  ) : null}
                  {mentionedFiles.length ? (
                    <div className="flex flex-wrap gap-1.5 px-1">
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="ml-auto size-6 rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground"
                            onClick={() => removeMentionedFile(file.fullPath)}
                            title="移除引用文件"
                            aria-label="移除引用文件"
                          >
                            <X className="size-3" />
                          </Button>
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {codeSelectionBadge ? (
                    <div className="flex flex-wrap gap-1.5 px-1">
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="ml-auto size-6 rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground"
                            onClick={onClearCodeSelection}
                            title="移除选中代码"
                            aria-label="移除选中代码"
                          >
                            <X className="size-3" />
                          </Button>
                        ) : null}
                      </Badge>
                    </div>
                  ) : null}
                  {draftImages.length ? (
                    <div className="flex flex-wrap gap-1.5 px-1">
                      {draftImages.map((img) => (
                        <div
                          key={img.clientId}
                          className={cn(
                            'relative size-14 overflow-hidden rounded-md border bg-background/30',
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

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={cn(
                              'absolute right-1 top-1 size-6 rounded-sm bg-background/70 text-muted-foreground',
                              'hover:bg-background hover:text-foreground',
                            )}
                            onClick={() => removeDraftImage(img.clientId)}
                            title="移除"
                            aria-label="移除"
                          >
                            <X className="size-3" />
                          </Button>

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

                  <div className="space-y-1.5">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      disabled={sending || canceling}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? [])
                        e.target.value = ''
                        addDraftImages(files)
                      }}
                    />

                    <textarea
                      ref={textareaRef}
                      className={cn(
                        'min-h-[56px] max-h-[120px] w-full resize-none rounded-lg bg-background/50 px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:ring-offset-2'
                      )}
                      placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                      value={draft}
                      rows={4}
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

                        if (e.key === 'Enter' && !e.shiftKey && !sending && !canceling) {
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
                        disabled={sending || canceling || draftImages.length >= maxDraftImages}
                        onClick={() => fileInputRef.current?.click()}
                        title="上传图片"
                      >
                        <ImageIcon className="size-4" />
                        <span className="sr-only">上传图片</span>
                      </Button>

                      <Popover
                        open={modelPickerOpen}
                        onOpenChange={(open) => {
                          setModelPickerOpen(open)
                          if (open) setModelPickerQuery('')
                        }}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={sending || canceling}
                            className="h-8 w-[160px] shrink-0 justify-between gap-2 px-2 text-xs"
                            title="选择模型"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {!modelSelection
                                ? `项目默认${project.model ? ` (${project.model})` : ''}`
                                : `${activeProvider?.name ?? '提供商'}: ${modelSelection.model}`}
                            </span>
                            <ChevronDown className="size-4 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          className="w-[320px] max-w-[calc(100vw-2rem)] p-0"
                        >
                          <div className="p-2">
                            <Input
                              ref={modelPickerSearchRef}
                              value={modelPickerQuery}
                              disabled={sending || canceling}
                              onChange={(e) => setModelPickerQuery(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter') return
                                if (!modelPickerQueryKey) return

                                const first = modelPickerProviderGroups[0] ?? null
                                const firstModel = first?.models[0] ?? first?.customModels[0] ?? null
                                if (!first || !firstModel) return

                                e.preventDefault()
                                setModelSelection({ providerId: first.provider.id, model: firstModel })
                                setModelPickerOpen(false)
                              }}
                              placeholder="搜索模型或提供商…"
                              className="h-8 text-xs"
                            />
                          </div>
                          <Separator />
                          <div className="max-h-[260px] overflow-auto p-1">
                            <button
                              type="button"
                              className={cn(
                                "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors",
                                !modelSelection && "bg-accent text-accent-foreground",
                              )}
                              onClick={() => {
                                setModelSelection(null)
                                setModelPickerOpen(false)
                              }}
                            >
                              <span className="min-w-0 flex-1 truncate">
                                项目默认{project.model ? ` (${project.model})` : ''}
                              </span>
                              {!modelSelection ? <Check className="size-4 opacity-70" /> : null}
                            </button>

                            {providersLoaded ? (
                              providers.length ? (
                                modelPickerProviderGroups.length ? (
                                  <div className="space-y-2 pt-1">
                                    {modelPickerProviderGroups.map((g, idx) => {
                                      return (
                                        <div key={g.provider.id} className="space-y-1">
                                          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                                            {g.provider.name}
                                          </div>

                                          {g.models.length
                                            ? g.models.map((m) => {
                                              const selected =
                                                modelSelection?.providerId === g.provider.id &&
                                                modelSelection.model === m
                                              return (
                                                <button
                                                  key={`${g.provider.id}:${m}`}
                                                  type="button"
                                                  className={cn(
                                                    "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors",
                                                    selected && "bg-accent text-accent-foreground",
                                                  )}
                                                  onClick={() => {
                                                    setModelSelection({
                                                      providerId: g.provider.id,
                                                      model: m,
                                                    })
                                                    setModelPickerOpen(false)
                                                  }}
                                                >
                                                  <span className="min-w-0 flex-1 truncate">
                                                    {m}
                                                  </span>
                                                  {selected ? (
                                                    <Check className="size-4 opacity-70" />
                                                  ) : null}
                                                </button>
                                              )
                                            })
                                            : null}

                                          {!g.models.length &&
                                            !g.customModels.length &&
                                            g.provider.models.length === 0 ? (
                                            <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                              未缓存模型（可在“提供商管理”中拉取更新）
                                            </div>
                                          ) : null}

                                          {g.customModels.length ? (
                                            <div className="pt-1">
                                              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                                                自定义
                                              </div>
                                              {g.customModels.map((m) => {
                                                const selected =
                                                  modelSelection?.providerId === g.provider.id &&
                                                  modelSelection.model === m
                                                return (
                                                  <button
                                                    key={`${g.provider.id}:custom:${m}`}
                                                    type="button"
                                                    className={cn(
                                                      "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors",
                                                      selected && "bg-accent text-accent-foreground",
                                                    )}
                                                    onClick={() => {
                                                      setModelSelection({
                                                        providerId: g.provider.id,
                                                        model: m,
                                                      })
                                                      setModelPickerOpen(false)
                                                    }}
                                                  >
                                                    <span className="min-w-0 flex-1 truncate">
                                                      {m}
                                                    </span>
                                                    {selected ? (
                                                      <Check className="size-4 opacity-70" />
                                                    ) : null}
                                                  </button>
                                                )
                                              })}
                                            </div>
                                          ) : null}

                                          {idx < modelPickerProviderGroups.length - 1 ? (
                                            <Separator className="my-1" />
                                          ) : null}
                                        </div>
                                      )
                                    })}
                                  </div>
                                ) : (
                                  <div className="px-2 py-2 text-xs text-muted-foreground">
                                    未找到匹配模型
                                  </div>
                                )
                              ) : (
                                <div className="px-2 py-2 text-xs text-muted-foreground">
                                  未配置提供商
                                </div>
                              )
                            ) : (
                              <div className="px-2 py-2 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-2">
                                  <Spinner className="size-3" /> 加载提供商模型中…
                                </span>
                              </div>
                            )}
                          </div>
                          <Separator />
                          <div className="p-1">
                            <button
                              type="button"
                              className="hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground w-full rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors"
                              onClick={() => {
                                setModelPickerOpen(false)
                                openAddModelDialog()
                              }}
                            >
                              + 添加模型…
                            </button>
                          </div>
                        </PopoverContent>
                      </Popover>

                      <div className="ml-auto flex items-center gap-2">
                        {sending ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void cancel()}
                            disabled={canceling}
                            className="gap-1.5"
                          >
                            {canceling ? (
                              <>
                                <Spinner className="size-3" />
                                <span>停止中…</span>
                              </>
                            ) : (
                              <>
                                <Spinner className="size-3" />
                                <span>停止</span>
                              </>
                            )}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void send()}
                            disabled={
                              sending ||
                              canceling ||
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
            setAddModelProviderId('')
            setAddModelDraft('')
            setAddModelError(null)
          }}
          className="max-w-lg"
        >
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              请输入模型名称（例如：gpt-5.1-codex-max）。
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">提供商</div>
              <Select
                value={addModelProviderId}
                disabled={sending}
                onValueChange={(value) => {
                  setAddModelProviderId(value)
                  if (addModelError) setAddModelError(null)
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={providersLoaded ? '选择提供商' : '加载中…'} />
                </SelectTrigger>
                <SelectContent>
                  {providers.length ? (
                    providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))
                  ) : (
                    <div className="px-2 py-2 text-xs text-muted-foreground">未配置提供商</div>
                  )}
                </SelectContent>
              </Select>
            </div>
            <Input
              autoFocus
              value={addModelDraft}
              disabled={sending || canceling}
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
                  setAddModelProviderId('')
                  setAddModelDraft('')
                  setAddModelError(null)
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const providerId = addModelProviderId.trim()
                  if (!providerId) {
                    setAddModelError('请选择提供商')
                    return
                  }

                  const provider = providers.find((p) => p.id === providerId) ?? null
                  if (!provider) {
                    setAddModelError('提供商不存在或已被删除')
                    return
                  }

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
                  const providerHas = provider.models.some((m) => m.toLowerCase() === lower)

                  const customKey = `onecode:chat:custom-models:v1:${project.toolType}:${providerId}`
                  const existingCustomModels =
                    providerId === activeProviderId
                      ? customModels
                      : (() => {
                        if (typeof window === 'undefined') return []
                        try {
                          const raw = window.localStorage.getItem(customKey)
                          if (!raw) return []
                          const parsed = JSON.parse(raw) as unknown
                          if (!Array.isArray(parsed)) return []
                          return parsed
                            .filter((m): m is string => typeof m === 'string')
                            .map((m) => m.trim())
                            .filter(Boolean)
                        } catch {
                          return []
                        }
                      })()

                  const customHas = existingCustomModels.some((m) => m.toLowerCase() === lower)

                  if (!providerHas && !customHas) {
                    const map = new Map<string, string>()
                    for (const existing of existingCustomModels) {
                      const normalized = existing.trim()
                      if (!normalized) continue
                      map.set(normalized.toLowerCase(), normalized)
                    }
                    map.set(lower, model)
                    const nextModels = Array.from(map.values())

                    if (providerId === activeProviderId) {
                      persistCustomModels(nextModels)
                    } else if (typeof window !== 'undefined') {
                      try {
                        window.localStorage.setItem(customKey, JSON.stringify(nextModels))
                      } catch {
                        // ignore
                      }
                    }
                  }

                  setModelSelection({ providerId, model })
                  setAddModelOpen(false)
                  setAddModelProviderId('')
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
              </div>
            </div>,
            detailsPortalTarget,
          )
          : null}
      </>
    </TooltipProvider>
  )
}
