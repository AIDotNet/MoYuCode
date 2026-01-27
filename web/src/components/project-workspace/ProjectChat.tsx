import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/animate-ui/primitives/animate/tooltip'
import { Check, ChevronDown, Eye, EyeOff, Image as ImageIcon, X } from 'lucide-react'
import { useRouteTool } from '@/hooks/use-route-tool'
import { useProjectChatStore, type ChatMessage, type TokenUsageArtifact } from '@/stores/projectChatStore'
import { useToolInputParsers } from '@/components/project-workspace/tool-inputs/useToolInputParsers'
import { ToolItemContent } from '@/components/project-workspace/tool-contents/ToolItemContent'
import type { ExitPlanModeToolInput } from '@/components/project-workspace/tool-inputs/types'
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
  const tags = ['think', 'analysis', 'thinking']

  for (const tag of tags) {
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = raw.indexOf(open)
    if (start < 0) continue

    const end = raw.indexOf(close, start + open.length)
    if (end < 0 || end <= start) continue

    const before = raw.slice(0, start)
    const thinkText = raw.slice(start + open.length, end).trim()
    const after = raw.slice(end + close.length)

    if (!thinkText.trim()) return null

    const beforeTrimmedEnd = before.replace(/\s+$/, '')
    const afterTrimmedStart = after.replace(/^\s+/, '')
    const spacer = beforeTrimmedEnd && afterTrimmedStart ? '\n\n' : ''
    const visibleText = `${beforeTrimmedEnd}${spacer}${afterTrimmedStart}`

    return { thinkText, visibleText }
  }

  return null
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

type ExecCommandOutputDelta = {
  callId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

function tryExtractExecCommandOutputDelta(raw: string, method?: string): ExecCommandOutputDelta | null {
  const combined = `${method ?? ''}\n${raw}`.toLowerCase()
  if (!combined.includes('exec_command_output_delta') && !combined.includes('commandexecution/outputdelta')) {
    return null
  }

  let ev: unknown
  try {
    ev = JSON.parse(raw)
  } catch {
    return null
  }

  if (!ev || typeof ev !== 'object') return null
  const evObj = ev as { params?: unknown }
  const params = evObj.params
  if (!params || typeof params !== 'object') return null

  const p = params as { msg?: unknown; itemId?: unknown; delta?: unknown }
  const msg = p.msg as Record<string, unknown> | undefined

  // Handle codex/event/exec_command_output_delta format
  if (msg && typeof msg === 'object') {
    const callId = typeof msg.call_id === 'string' ? msg.call_id : undefined
    const stream = msg.stream === 'stderr' ? 'stderr' : 'stdout'
    const chunk = typeof msg.chunk === 'string' ? msg.chunk : ''
    if (callId && chunk) {
      // chunk is base64 encoded
      try {
        const decoded = atob(chunk)
        return { callId, stream, chunk: decoded }
      } catch {
        return { callId, stream, chunk }
      }
    }
  }

  // Handle item/commandExecution/outputDelta format
  const itemId = typeof p.itemId === 'string' ? p.itemId : undefined
  const delta = typeof p.delta === 'string' ? p.delta : ''
  if (itemId && delta) {
    return { callId: itemId, stream: 'stdout', chunk: delta }
  }

  return null
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
    combined.includes('mcp') ||
    combined.includes('exec_command')

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
      type === 'mcp_tool_call_end' ||
      type === 'exec_command' ||
      type === 'exec_command_begin'

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

function normalizeCodexRoleHint(value: string | null | undefined): ChatRole | null {
  const key = (value ?? '').trim().toLowerCase()
  if (!key) return null
  if (key.includes('assistant') || key.includes('agent')) return 'agent'
  if (key.includes('user')) return 'user'
  if (key.includes('system')) return 'system'
  return null
}

function inferCodexRole(value: unknown, depth = 0): ChatRole | null {
  if (!value || typeof value !== 'object' || depth > 3) return null
  const obj = value as Record<string, unknown>

  const roleHint = normalizeCodexRoleHint(
    readFirstNonEmptyString(obj, ['role', 'sender', 'author']),
  )
  if (roleHint) return roleHint

  const typeHint = normalizeCodexRoleHint(
    readFirstNonEmptyString(obj, ['type', 'kind', 'item_type', 'itemType']),
  )
  if (typeHint) return typeHint

  const nestedCandidates = [obj.item, obj.msg, obj.message, obj.data]
  for (const candidate of nestedCandidates) {
    const nestedHint = inferCodexRole(candidate, depth + 1)
    if (nestedHint) return nestedHint
  }

  return null
}

function readCodexReasoningDelta(value: unknown, depth = 0): string | null {
  if (value == null || depth > 4) return null

  if (typeof value === 'string') return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readCodexReasoningDelta(item, depth + 1)
      if (found) return found
    }
    return null
  }

  if (typeof value !== 'object') return null
  const obj = value as Record<string, unknown>

  const typeHint = readFirstNonEmptyString(obj, ['type', 'kind', 'event', 'eventType'])
  const typeKey = (typeHint ?? '').toLowerCase()
  const isReasoningType = typeKey.includes('reasoning') || typeKey.includes('thinking')

  if (isReasoningType) {
    const delta = readFirstNonEmptyString(obj, ['delta', 'text', 'thinking'])
    if (delta) return delta
  }

  if (!typeHint) {
    const delta = readFirstNonEmptyString(obj, ['delta', 'text', 'thinking'])
    if (delta) return delta
  }

  const nestedCandidates = [obj.msg, obj.item, obj.message, obj.data]
  for (const candidate of nestedCandidates) {
    const nested = readCodexReasoningDelta(candidate, depth + 1)
    if (nested) return nested
  }

  return null
}

function tryExtractCodexReasoningDelta(raw: string, method?: string): string | null {
  const combined = `${method ?? ''}\n${raw}`.toLowerCase()
  const mightContainReasoning = combined.includes('reasoning') || combined.includes('thinking')
  if (!mightContainReasoning) return null

  const parsed = tryParseJsonRecord(raw)
  if (!parsed) return null

  const paramsValue = parsed.params
  const candidates: unknown[] = []
  if (paramsValue && typeof paramsValue === 'object') {
    const params = paramsValue as Record<string, unknown>
    candidates.push(params.msg, params.item, params.delta, params)
  } else {
    candidates.push(paramsValue)
  }

  for (const candidate of candidates) {
    const delta = readCodexReasoningDelta(candidate, 0)
    if (delta) return delta
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

    const roleHint = inferCodexRole(obj, 0)
    if (roleHint && roleHint !== 'agent') continue

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
  onComposeAskUserQuestion,
}: {
  message: ChatMessage
  openById: OpenById
  onToggle: (id: string) => void
  onSubmitAskUserQuestion?: (toolUseId: string, answers: Record<string, string>, messageId: string) => void
  askUserQuestionDisabled: boolean
  onComposeAskUserQuestion?: (answers: Record<string, string>) => void
}) {
  const open = openById[message.id] ?? false
  const toolName = message.toolName ?? 'tool'
  const input = message.toolInput ?? message.text ?? ''
  const output = message.toolOutput ?? ''
  const isError = Boolean(message.toolIsError)

  const parsedInputData = useToolInputParsers(toolName, input)

  const exitPlanFromOutput = useMemo(() => {
    const trimmed = (output ?? '').trim()
    if (!trimmed) return null

    const tryExtractExitPlanFromValue = (value: unknown): ExitPlanModeToolInput | null => {
      if (value == null) return null

      if (typeof value === 'string') {
        const nestedTrimmed = value.trim()
        if (!nestedTrimmed) return null
        if (nestedTrimmed.startsWith('{') || nestedTrimmed.startsWith('[')) {
          const parsed = tryParseJsonValue(nestedTrimmed)
          const extracted = parsed ? tryExtractExitPlanFromValue(parsed) : null
          if (extracted) return extracted
        }
        return null
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          const extracted = tryExtractExitPlanFromValue(entry)
          if (extracted) return extracted
        }
        return null
      }

      if (typeof value !== 'object') return null
      const obj = value as Record<string, unknown>

      const filePath =
        typeof obj.filePath === 'string'
          ? obj.filePath
          : typeof obj.file_path === 'string'
            ? obj.file_path
            : null
      const planValue = obj.plan
      const plan = typeof planValue === 'string' ? planValue : null
      const isAgent = obj.isAgent === true || obj.is_agent === true

      if (filePath || planValue === null || typeof planValue === 'string') {
        return {
          plan: plan ?? null,
          isAgent,
          filePath: filePath ?? '',
        }
      }

      for (const key of ['text', 'content', 'data']) {
        const nested = tryExtractExitPlanFromValue(obj[key])
        if (nested) return nested
      }

      return null
    }

    return tryExtractExitPlanFromValue(trimmed)
  }, [output])

  const inputData = useMemo(
    () => ({
      ...parsedInputData,
      exitPlanModeInput: parsedInputData.exitPlanModeInput ?? exitPlanFromOutput ?? null,
    }),
    [parsedInputData, exitPlanFromOutput],
  )

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
    if (inputData.enterPlanModeInput) {
      return 'EnterPlanMode'
    }
    if (inputData.exitPlanModeInput) {
      return 'ExitPlanMode'
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
    if (inputData.enterPlanModeInput) {
      return truncateInlineText(inputData.enterPlanModeInput.message, 140)
    }
    if (inputData.exitPlanModeInput) {
      return truncateInlineText(inputData.exitPlanModeInput.filePath || 'Plan completed', 140)
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
            onComposeAskUserQuestion={onComposeAskUserQuestion}
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
  onComposeAskUserQuestion,
}: {
  toolMessages: ChatMessage[]
  align: ChatAlign
  openById: OpenById
  onToggle: (id: string) => void
  isActive: boolean
  onSubmitAskUserQuestion?: (toolUseId: string, answers: Record<string, string>, messageId: string) => void
  askUserQuestionDisabled: boolean
  onComposeAskUserQuestion?: (answers: Record<string, string>) => void
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
                onComposeAskUserQuestion={onComposeAskUserQuestion}
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
  onComposeAskUserQuestion,
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
  onComposeAskUserQuestion?: (answers: Record<string, string>) => void
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
                onComposeAskUserQuestion={onComposeAskUserQuestion}
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

// 插入 tool 消息时，找到最后一个 tool 消息或锚点消息，确保新 tool 在正确位置
function insertToolMessage(
  prev: ChatMessage[],
  anchorMessageId: string | null | undefined,
  message: ChatMessage,
): ChatMessage[] {
  // 先找锚点位置
  let anchorIndex = anchorMessageId ? prev.findIndex((m) => m.id === anchorMessageId) : -1
  
  // 从锚点位置向后找最后一个连续的 tool 消息
  if (anchorIndex >= 0) {
    let lastToolIndex = anchorIndex
    for (let i = anchorIndex + 1; i < prev.length; i++) {
      if (prev[i].kind === 'tool' && prev[i].role === 'agent') {
        lastToolIndex = i
      } else {
        break
      }
    }
    // 如果找到了 tool 消息，在最后一个 tool 后面插入
    if (lastToolIndex > anchorIndex || (prev[anchorIndex]?.kind === 'tool' && prev[anchorIndex]?.role === 'agent')) {
      const next = [...prev]
      next.splice(lastToolIndex + 1, 0, message)
      return next
    }
  }
  
  // 否则使用默认的插入逻辑
  return insertAfterMessage(prev, anchorMessageId, message)
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
  onFirstMessage,
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
  onFirstMessage?: (text: string) => void
}) {
  const apiBase = useMemo(() => getApiBase(), [])
  const sessionIdRef = useRef<string>(sessionId ?? createUuid())
  const workspacePath = project.workspacePath.trim()
  const routeTool = useRouteTool()

  // 持久化状态管理
  const chatStore = useProjectChatStore()
  const currentProjectIdRef = useRef<string>(project.id)
  const isInitializedRef = useRef(false)

  // 获取当前项目的持久化状态
  const getPersistedState = useCallback(() => {
    return chatStore.getState(project.id)
  }, [chatStore, project.id])

  useEffect(() => {
    if (sessionId) {
      sessionIdRef.current = sessionId
    }
  }, [sessionId])

  // 从持久化状态初始化
  const initialState = useMemo(() => getPersistedState(), [])
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    sessionId ? [] : initialState.messages
  )
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyCursor, setHistoryCursor] = useState<number | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyInitialized, setHistoryInitialized] = useState(false)
  const [draft, setDraft] = useState(() => initialState.draft)
  const [draftImages, setDraftImages] = useState<DraftImage[]>([])
  const [todoDockOpen, setTodoDockOpen] = useState(() => initialState.todoDockOpen)
  const [sending, setSending] = useState(() => initialState.sending)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(() => initialState.activeTaskId)
  const [activeReasoningMessageId, setActiveReasoningMessageId] = useState<string | null>(
    () => initialState.activeReasoningMessageId,
  )
  const [canceling, setCanceling] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [toolOutput, setToolOutput] = useState(() => initialState.toolOutput)
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
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>(() => initialState.mentionedFiles)
  const [includeActiveFileInPrompt, setIncludeActiveFileInPrompt] = useState(() => initialState.includeActiveFileInPrompt)

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

  const [thinkOpenById, setThinkOpenById] = useState<Record<string, boolean>>(() => initialState.thinkOpenById)
  const [toolOpenById, setToolOpenById] = useState<Record<string, boolean>>(() => initialState.toolOpenById)
  const [tokenByMessageId, setTokenByMessageId] = useState<Record<string, TokenUsageArtifact>>(
    () => initialState.tokenByMessageId,
  )

  const [rawEvents, setRawEvents] = useState<CodexEventLogItem[]>(() => initialState.rawEvents)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelPickerQuery, setModelPickerQuery] = useState('')
  const modelPickerSearchRef = useRef<HTMLInputElement | null>(null)
  const [customModelsByProvider, setCustomModelsByProvider] = useState<Record<string, string[]>>({})

  // 恢复滚动位置
  useLayoutEffect(() => {
    if (!isInitializedRef.current && scrollRef.current && initialState.scrollTop > 0) {
      scrollRef.current.scrollTop = initialState.scrollTop
    }
    isInitializedRef.current = true
  }, [initialState.scrollTop])

  // 当项目切换时，从 store 恢复状态
  useEffect(() => {
    if (currentProjectIdRef.current === project.id) return

    // 保存当前项目的状态
    chatStore.setState(currentProjectIdRef.current, {
      messages: sessionId ? [] : messages,
      draft,
      thinkOpenById,
      toolOpenById,
      tokenByMessageId,
      rawEvents,
      toolOutput,
      mentionedFiles,
      includeActiveFileInPrompt,
      todoDockOpen,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
      sending,
      activeTaskId,
      activeReasoningMessageId,
    })

    // 更新当前项目 ID
    currentProjectIdRef.current = project.id

    // 从 store 恢复新项目的状态
    const newState = chatStore.getState(project.id)
    if (!sessionId) {
      setMessages(newState.messages)
    }
    setDraft(newState.draft)
    setThinkOpenById(newState.thinkOpenById)
    setToolOpenById(newState.toolOpenById)
    setTokenByMessageId(newState.tokenByMessageId)
    setRawEvents(newState.rawEvents)
    setToolOutput(newState.toolOutput)
    setMentionedFiles(newState.mentionedFiles)
    setIncludeActiveFileInPrompt(newState.includeActiveFileInPrompt)
    setTodoDockOpen(newState.todoDockOpen)
    setSending(newState.sending)
    setActiveTaskId(newState.activeTaskId)
    setActiveReasoningMessageId(newState.activeReasoningMessageId)

    // 恢复滚动位置
    if (scrollRef.current && newState.scrollTop > 0) {
      scrollRef.current.scrollTop = newState.scrollTop
    }
  }, [project.id])

  // 同步状态到 store（使用 debounce 避免频繁更新）
  const syncTimeoutRef = useRef<number | null>(null)
  useEffect(() => {
    if (syncTimeoutRef.current) {
      window.clearTimeout(syncTimeoutRef.current)
    }
    syncTimeoutRef.current = window.setTimeout(() => {
      chatStore.setState(project.id, {
        messages: sessionId ? [] : messages,
        draft,
        thinkOpenById,
        toolOpenById,
        tokenByMessageId,
        rawEvents,
        toolOutput,
        mentionedFiles,
        includeActiveFileInPrompt,
        todoDockOpen,
        scrollTop: scrollRef.current?.scrollTop ?? 0,
        sending,
        activeTaskId,
        activeReasoningMessageId,
      })
    }, 300)

    return () => {
      if (syncTimeoutRef.current) {
        window.clearTimeout(syncTimeoutRef.current)
      }
    }
  }, [
    chatStore,
    project.id,
    sessionId,
    messages,
    draft,
    thinkOpenById,
    toolOpenById,
    tokenByMessageId,
    rawEvents,
    toolOutput,
    mentionedFiles,
    includeActiveFileInPrompt,
    todoDockOpen,
    sending,
    activeTaskId,
    activeReasoningMessageId,
  ])

  // 组件卸载时立即保存状态
  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) {
        window.clearTimeout(syncTimeoutRef.current)
      }
      chatStore.setState(project.id, {
        messages: sessionId ? [] : messages,
        draft,
        thinkOpenById,
        toolOpenById,
        tokenByMessageId,
        rawEvents,
        toolOutput,
        mentionedFiles,
        includeActiveFileInPrompt,
        todoDockOpen,
        scrollTop: scrollRef.current?.scrollTop ?? 0,
        sending,
        activeTaskId,
        activeReasoningMessageId,
      })
    }
  }, [])

  // 当组件挂载时，如果有活跃的任务，尝试重新订阅
  // 这处理了用户切换页面后返回的情况
  useEffect(() => {
    if (!sending || !activeTaskId) return
    if (sessionId) return // 历史会话不需要重新订阅

    const controller = new AbortController()
    abortRef.current = controller

    const resubscribe = async () => {
      try {
        const request = {
          jsonrpc: '2.0',
          id: randomId('req'),
          method: 'tasks/resubscribe',
          params: {
            id: activeTaskId,
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
          // 任务可能已经完成或不存在，重置状态
          setSending(false)
          setActiveTaskId(null)
          setActiveReasoningMessageId(null)
          return
        }

        // 处理 SSE 响应 - 简化版本，只处理完成状态
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
            setSending(false)
            setActiveTaskId(null)
            setActiveReasoningMessageId(null)
            return
          }

          const result = envelope.result ?? null
          if (!result || typeof result !== 'object') continue

          const resultObj = result as { statusUpdate?: unknown }
          const statusUpdate = resultObj.statusUpdate as { final?: boolean } | null

          // 如果收到 final 状态，说明任务已完成
          if (statusUpdate?.final) {
            setSending(false)
            setActiveTaskId(null)
            setActiveReasoningMessageId(null)
            return
          }
        }

        // SSE 流结束
        setSending(false)
        setActiveTaskId(null)
        setActiveReasoningMessageId(null)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setSending(false)
          setActiveTaskId(null)
          setActiveReasoningMessageId(null)
        }
      }
    }

    void resubscribe()

    return () => {
      // Task 4.1 & 4.2: Cleanup SSE connection on component unmount
      // Abort the request to properly close the SSE connection
      controller.abort()
    }
  }, []) // 只在组件挂载时运行一次

  // Task 4.2: Cleanup all active connections when component unmounts
  useEffect(() => {
    return () => {
      // Abort any active SSE connection when component unmounts
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [])

  const modelSelectionStorageKey = useMemo(() => {
    return `myyucode:chat:model-selection:v2:${project.id}`
  }, [project.id])

  const legacyModelOverrideStorageKey = useMemo(() => {
    return `myyucode:chat:model-override:v1:${project.id}`
  }, [project.id])

  const activeProviderId = useMemo(() => {
    return modelSelection?.providerId ?? project.providerId ?? null
  }, [modelSelection?.providerId, project.providerId])

  const customModelStorageKey = useMemo(() => {
    const providerKey = activeProviderId ?? 'default'
    return `myyucode:chat:custom-models:v1:${project.toolType}:${providerKey}`
  }, [activeProviderId, project.toolType])

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
      const customKey = `myyucode:chat:custom-models:v1:${project.toolType}:${provider.id}`
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

    // 如果是第一条消息，通知父组件（用于设置会话标题）
    const isFirstMessage = messages.length === 0
    if (isFirstMessage && text && onFirstMessage) {
      // 截取前50个字符作为标题
      const title = text.length > 50 ? text.slice(0, 47) + '...' : text
      onFirstMessage(title)
    }

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
    const isClaude = project.toolType === 'ClaudeCode'
    let activeAgentTextMessageId = agentMessageId
    let agentTextSegmentIndex = 1
    let sawAnyAgentText = false
    let toolChainTailMessageId: string | null = null
    let startNewTextSegmentAfterTools = false
    type StreamKind = 'text' | 'think' | 'tool'
    let lastStreamKind: StreamKind | null = null
    let streamTailMessageId: string | null = agentMessageId
    let canReuseInitialTextMessage = true

    const markStreamTail = (kind: StreamKind, messageId: string) => {
      lastStreamKind = kind
      streamTailMessageId = messageId
      if (messageId !== agentMessageId) {
        canReuseInitialTextMessage = false
      }
    }

    const appendAgentTextChunk = (updater: (prev: string) => string) => {
      const canAppendToExisting =
        lastStreamKind === 'text' &&
        Boolean(activeAgentTextMessageId) &&
        streamTailMessageId === activeAgentTextMessageId &&
        !startNewTextSegmentAfterTools

      if (canAppendToExisting) {
        updateMessageText(activeAgentTextMessageId, (prev) => updater(prev))
        sawAnyAgentText = true
        markStreamTail('text', activeAgentTextMessageId)
        if (toolChainTailMessageId) {
          toolChainTailMessageId = null
        }
        return
      }

      let nextTextId: string
      if (
        !sawAnyAgentText &&
        canReuseInitialTextMessage &&
        streamTailMessageId === agentMessageId
      ) {
        nextTextId = agentMessageId
      } else {
        agentTextSegmentIndex += 1
        nextTextId = `${agentMessageId}-seg-${agentTextSegmentIndex}`
      }

      activeAgentTextMessageId = nextTextId
      sawAnyAgentText = true
      startNewTextSegmentAfterTools = false
      if (toolChainTailMessageId) {
        toolChainTailMessageId = null
      }

      const nextText = updater('')
      if (nextTextId === agentMessageId) {
        updateMessageText(nextTextId, () => nextText)
        markStreamTail('text', nextTextId)
        return
      }

      const textMessage: ChatMessage = {
        id: nextTextId,
        role: 'agent',
        kind: 'text',
        text: nextText,
      }
      setMessages((prev) => insertAfterMessage(prev, streamTailMessageId, textMessage))
      markStreamTail('text', nextTextId)
    }

    const appendThinkChunk = (chunk: string) => {
      const canAppendToExisting =
        lastStreamKind === 'think' &&
        Boolean(activeThinkMessageId) &&
        streamTailMessageId === activeThinkMessageId

      if (canAppendToExisting) {
        const targetThinkId = activeThinkMessageId as string
        setMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === targetThinkId)
          if (existingIndex >= 0) {
            const next = [...prev]
            const existing = next[existingIndex]
            next[existingIndex] = { ...existing, text: existing.text + chunk }
            return next
          }
          const message: ChatMessage = {
            id: targetThinkId,
            role: 'agent',
            kind: 'think',
            text: chunk,
          }
          return insertAfterMessage(prev, streamTailMessageId, message)
        })
        setActiveReasoningMessageId(targetThinkId)
        setThinkOpenById((prev) =>
          prev[targetThinkId] !== undefined ? prev : { ...prev, [targetThinkId]: true },
        )
        markStreamTail('think', targetThinkId)
        return
      }

      thinkSegmentIndex += 1
      const nextThinkId = `${thinkMessageIdPrefix}${thinkSegmentIndex}`
      activeThinkMessageId = nextThinkId
      const message: ChatMessage = {
        id: nextThinkId,
        role: 'agent',
        kind: 'think',
        text: chunk,
      }
      setMessages((prev) => insertAfterMessage(prev, streamTailMessageId, message))
      setActiveReasoningMessageId(nextThinkId)
      setThinkOpenById((prev) =>
        prev[nextThinkId] !== undefined ? prev : { ...prev, [nextThinkId]: true },
      )
      markStreamTail('think', nextThinkId)
    }

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
              if (!(statusUpdate.final && sawAnyAgentText)) {
                const updater = statusUpdate.final
                  ? () => chunk
                  : (prev: string) => prev + chunk
                appendAgentTextChunk(updater)
              }
            } else {
              const updater = statusUpdate.final
                ? () => chunk
                : (prev: string) => prev + chunk
              appendAgentTextChunk(updater)
            }
          }
        }

        const artifactUpdate = (resultObj.artifactUpdate ?? null) as A2aArtifactUpdate | null
        const artifact = artifactUpdate?.artifact
        const artifactName = artifact?.name ?? ''
        const artifactKey = artifactName.toLowerCase()

        if (!isClaude && artifactKey === 'tool-output') {
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

              lastStreamKind = 'tool'
              continue
            }

            setToolOpenById((prev) =>
              prev[toolOutputMessageId] !== undefined
                ? prev
                : { ...prev, [toolOutputMessageId]: true },
            )

            lastStreamKind = 'tool'
          }
          continue
        }

        if (
          artifactKey === 'reasoning' ||
          artifactKey === 'agent_reasoning' ||
          artifactKey === 'agentreasoning' ||
          artifactKey === 'thinking'
        ) {
          const parts = (artifact?.parts ?? []) as unknown[]
          const chunk = readPartsText(parts)
          if (chunk) {
            appendThinkChunk(chunk)
          }
          continue
        }

        if (artifactKey === 'token-usage') {
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

        if (artifactKey === 'claude-tools') {
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

              const hadToolChain = Boolean(toolChainTailMessageId)
              if (!hadToolChain) {
                startNewTextSegmentAfterTools = true
              }

              setToolOpenById((prev) =>
                prev[toolMessageId] !== undefined
                  ? prev
                  : { ...prev, [toolMessageId]: shouldAutoOpenClaudeTool(resolvedToolName) },
              )

              const anchorAfterId = streamTailMessageId
              let inserted = false
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
                inserted = true
                return insertToolMessage(prev, anchorAfterId, toolMessage)
              })

              if (inserted) {
                toolChainTailMessageId = toolMessageId
                markStreamTail('tool', toolMessageId)
              } else {
                lastStreamKind = 'tool'
              }

              activeThinkMessageId = null
              setActiveReasoningMessageId(null)
              continue
            }

            if (kind === 'tool_result') {
              const toolMessageId = ensureToolMessageId()
              const resolvedToolName = toolName ?? toolNameByUseId.get(toolUseId) ?? 'tool'
              const hadToolChain = Boolean(toolChainTailMessageId)
              if (!hadToolChain) {
                startNewTextSegmentAfterTools = true
              }

              setToolOpenById((prev) =>
                prev[toolMessageId] !== undefined
                  ? prev
                  : { ...prev, [toolMessageId]: shouldAutoOpenClaudeTool(resolvedToolName) },
              )

              const anchorAfterId = streamTailMessageId
              let inserted = false
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

                inserted = true
                return insertToolMessage(prev, anchorAfterId, toolMessage)
              })

              if (inserted) {
                toolChainTailMessageId = toolMessageId
                markStreamTail('tool', toolMessageId)
              } else {
                lastStreamKind = 'tool'
              }

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

        if (artifactKey === 'codex-events') {
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

            const reasoningDelta = tryExtractCodexReasoningDelta(raw, method)
            if (reasoningDelta) {
              // Codex reasoning deltas are already streamed via reasoning artifacts.
              continue
            }

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

              const hadToolChain = Boolean(toolChainTailMessageId)
              if (!hadToolChain) {
                startNewTextSegmentAfterTools = true
              }

              const anchorAfterId = streamTailMessageId
              setMessages((prev) => insertToolMessage(prev, anchorAfterId, toolMessage))
              toolChainTailMessageId = toolMessageId
              markStreamTail('tool', toolMessageId)

              // Split reasoning around tool boundaries so the timeline reads:
              // 思考 -> Tool -> 思考 -> Text
              activeThinkMessageId = null
              setActiveReasoningMessageId(null)
              continue
            }

            // Handle exec_command_output_delta events - append output to existing tool message
            const execOutputDelta = tryExtractExecCommandOutputDelta(raw, method)
            if (execOutputDelta) {
              const { callId, chunk } = execOutputDelta
              const toolMessageId = `msg-tool-${taskId}-${callId}`

              // Check if tool message exists, if not create one
              setMessages((prev) => {
                const existingIndex = prev.findIndex((m) => m.id === toolMessageId)
                if (existingIndex >= 0) {
                  // Append to existing tool output
                  const next = [...prev]
                  const existing = next[existingIndex]
                  next[existingIndex] = {
                    ...existing,
                    toolOutput: (existing.toolOutput ?? '') + chunk,
                  }
                  return next
                }
                // Tool message doesn't exist yet, create it
                const toolMessage: ChatMessage = {
                  id: toolMessageId,
                  role: 'agent',
                  kind: 'tool',
                  toolName: 'shell',
                  toolUseId: callId,
                  toolInput: '',
                  toolOutput: chunk,
                  text: '',
                }
                const anchorAfterId = streamTailMessageId || (prev.length > 0 ? prev[prev.length - 1].id : '')
                if (!anchorAfterId) return [...prev, toolMessage]
                const anchorIndex = prev.findIndex((m) => m.id === anchorAfterId)
                if (anchorIndex < 0) return [...prev, toolMessage]
                const result = [...prev]
                result.splice(anchorIndex + 1, 0, toolMessage)
                return result
              })

              // Update toolChainTailMessageId if needed
              if (!toolChainTailMessageId) {
                toolChainTailMessageId = toolMessageId
                markStreamTail('tool', toolMessageId)
              }

              // Auto-open the tool panel
              setToolOpenById((prev) =>
                prev[toolMessageId] !== undefined ? prev : { ...prev, [toolMessageId]: true },
              )

              setToolOutput((prev) => prev + chunk)
              onToolOutput?.(chunk)
              continue
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

            appendAgentTextChunk((prev) => mergeStreamingText(prev, trimmed))
          }
        }
      }

      setSending(false)
      setActiveReasoningMessageId(null)
      setActiveTaskId(null)
      setCanceling(false)
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
    messages.length,
    modelSelection,
    onFirstMessage,
    onToolOutput,
    project.id,
    project.toolType,
    project.workspacePath,
    sending,
    updateMessageText,
  ])

  const formatAskUserQuestionAnswers = useCallback((answers: Record<string, string>) => {
    return Object.entries(answers)
      .map(([question, answer]) => `"${question}"="${answer}"`)
      .join(', ')
  }, [])

  const submitAskUserQuestion = useCallback(
    async (toolUseId: string, answers: Record<string, string>, messageId: string) => {
      const formatted = formatAskUserQuestionAnswers(answers)

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

      if (!activeTaskId || !toolUseId) {
        return
      }

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
    [activeTaskId, apiBase, formatAskUserQuestionAnswers],
  )

  const composeAskUserQuestionAnswers = useCallback(
    (answers: Record<string, string>) => {
      const formatted = formatAskUserQuestionAnswers(answers)
      if (!formatted) return

      setDraft((prev) => {
        const base = prev ?? ''
        const trimmed = base.trimEnd()
        const prefix = trimmed ? `${trimmed}\n\n` : ''
        return `${prefix}User answers: ${formatted}`
      })
      setChatError(null)
      setMentionToken(null)
      setMentionActiveIndex(0)

      if (typeof window !== 'undefined') {
        window.setTimeout(() => {
          const el = textareaRef.current
          if (!el) return
          el.focus()
          const nextLength = el.value.length
          el.setSelectionRange(nextLength, nextLength)
        }, 0)
      }
    },
    [formatAskUserQuestionAnswers],
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
      <div className="h-full w-full relative flex flex-col bg-background selection:bg-primary/10">
        {/* Chat Messages Area */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 overflow-y-auto scroll-smooth custom-scrollbar px-4"
        >
          {/* Top Padding for the floating header/toggle area */}
          <div className="h-16 shrink-0" />

          {chatError && (
            <div className="mx-auto max-w-3xl px-4 py-3">
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 flex items-start gap-3">
                <div className="text-sm text-destructive font-medium flex-1">{chatError}</div>
                <Button variant="ghost" size="icon-sm" onClick={() => setChatError(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          )}

          {!messages.length && (!sessionId || !historyLoading) && (
            <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
              <div className="animate-in fade-in zoom-in duration-700 delay-200">
                <div className="text-3xl font-bold tracking-tight text-foreground/80 mb-2">MoYu Codex</div>
                <div className="text-base text-muted-foreground max-w-sm">
                  准备好开始工作了吗？我可以帮你编写代码、分析项目或执行终端命令。
                </div>
              </div>
            </div>
          )}

          {sessionId && historyLoading && (
            <div className="py-8 flex items-center justify-center text-xs text-muted-foreground animate-pulse">
              <Spinner className="size-4 mr-2" /> 正在同步历史记录…
            </div>
          )}

          {historyError && (
            <div className="mx-auto max-w-2xl px-4 py-4 text-center text-sm text-destructive font-medium">
              记录加载同步失败：{historyError}
            </div>
          )}

          <div className="mx-auto w-full max-w-3xl">
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
              askUserQuestionDisabled={sending || canceling}
              onComposeAskUserQuestion={composeAskUserQuestionAnswers}
            />
          </div>

          {/* Bottom spacer to prevent input overlapping last message */}
          <div style={{ height: scrollBottomPaddingPx }} className="shrink-0" />
        </div>

        {/* Floating Composer Area (ChatGPT Style) */}
        <div
          ref={composerOverlayRef}
          className="absolute inset-x-0 bottom-0 z-20 pointer-events-none pb-6 pt-12 bg-gradient-to-t from-background via-background/90 to-transparent"
        >
          <div className="mx-auto w-full max-w-3xl px-4">
            <div className="pointer-events-auto relative flex flex-col gap-2 rounded-2xl bg-muted/40 backdrop-blur-xl border border-border/40 shadow-2xl transition-all focus-within:bg-muted/60 focus-within:border-primary/20">
              
              {/* Context Attachments (Files/Images) */}
              <div className="flex flex-col gap-1.5 px-3 pt-3">
                {mentionToken && (
                  <div className="absolute inset-x-0 bottom-full mb-4 mx-2 overflow-hidden rounded-2xl border bg-popover shadow-2xl animate-in slide-in-from-bottom-2 duration-200">
                    <div className="bg-muted/50 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground border-b border-border/40 flex items-center justify-between">
                      <span>文件引用 {mentionToken.query && `@${mentionToken.query}`}</span>
                      {workspaceFilesTruncated && <Badge variant="outline" className="h-4 text-[9px]">TRUNCATED</Badge>}
                    </div>
                    <div className="max-h-[320px] overflow-auto p-1.5 custom-scrollbar">
                      {workspaceFilesLoading && !workspaceFiles.length ? (
                        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                          <Spinner className="size-3.5" /> 检索项目结构中…
                        </div>
                      ) : mentionSuggestions.length ? (
                        <div className="grid gap-0.5">
                          {mentionSuggestions.map((item, idx) => (
                            <Button
                              key={item.fullPath}
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'h-auto w-full justify-start gap-3 px-3 py-2 text-left rounded-lg transition-all',
                                idx === mentionActiveIndex ? 'bg-accent shadow-sm' : 'hover:bg-accent/50',
                              )}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => applyMentionSuggestion(item.fullPath)}
                            >
                              <img src={item.iconUrl || ''} className="size-4.5 shrink-0 opacity-80" alt="" />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate leading-tight">{item.baseName}</div>
                                <div className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">{item.relativePath}</div>
                              </div>
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground italic">未找到匹配文件</div>
                      )}
                    </div>
                  </div>
                )}

                {/* Status Badges Row */}
                <div className="flex flex-wrap gap-2">
                  {todoDockInput?.todos.length ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 rounded-lg bg-background/50 border-border/40 hover:bg-background transition-all"
                      onClick={() => setTodoDockOpen((prev) => !prev)}
                    >
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">TODO</span>
                      <div className="bg-primary/10 text-primary size-4 rounded-full flex items-center justify-center text-[9px] font-black">
                        {todoDockInput.todos.length}
                      </div>
                    </Button>
                  ) : null}

                  {activeOpenFileBadge && (
                    <Badge variant="secondary" className={cn(
                      "h-7 gap-2 pl-2 pr-1 rounded-lg border-border/20 transition-all",
                      includeActiveFileInPrompt ? "bg-primary/5 text-primary-foreground border-primary/20" : "opacity-50 grayscale"
                    )}>
                      <img src={activeOpenFileBadge.iconUrl || ''} className="size-3.5 opacity-80" alt="" />
                      <span className="text-[11px] font-medium truncate max-w-[120px]">{getBaseName(activeOpenFileBadge.filePath)}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5 rounded-md hover:bg-background/80"
                        onClick={() => setIncludeActiveFileInPrompt(!includeActiveFileInPrompt)}
                      >
                        {includeActiveFileInPrompt ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                      </Button>
                    </Badge>
                  )}

                  {mentionedFiles.map((file) => (
                    <Badge key={file.fullPath} variant="secondary" className="h-7 gap-2 pl-2 pr-1 rounded-lg bg-accent/50 border-border/20">
                      <img src={file.iconUrl || ''} className="size-3.5" alt="" />
                      <span className="text-[11px] font-medium truncate max-w-[120px]">{file.baseName}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5 rounded-md hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => removeMentionedFile(file.fullPath)}
                      >
                        <X className="size-3" />
                      </Button>
                    </Badge>
                  ))}
                  
                  {draftImages.map((img) => (
                    <div key={img.clientId} className="relative group/img">
                      <div className="size-10 rounded-lg overflow-hidden border border-border/40 shadow-sm transition-transform group-hover/img:scale-105">
                        <img src={img.url || ''} className="h-full w-full object-cover" alt="" />
                        {img.status === 'uploading' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                            <Spinner className="size-4" />
                          </div>
                        )}
                      </div>
                      <Button
                        variant="destructive"
                        size="icon"
                        className="absolute -top-1.5 -right-1.5 size-4.5 rounded-full shadow-md scale-0 group-hover/img:scale-100 transition-transform"
                        onClick={() => removeDraftImage(img.clientId)}
                      >
                        <X className="size-2.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Main Input Field */}
              <div className="px-1">
                <textarea
                  ref={textareaRef}
                  className="w-full bg-transparent px-4 py-3 text-sm focus:outline-none placeholder:text-muted-foreground/60 min-h-[44px] max-h-[200px] resize-none leading-relaxed"
                  placeholder="给 Codex 发送消息或指令..."
                  value={draft}
                  rows={1}
                  onChange={(e) => {
                    const value = e.target.value
                    setDraft(value)
                    syncMentionToken(value, e.target.selectionStart ?? value.length)
                  }}
                  onKeyDown={(e) => {
                    // ... same mention/enter logic ...
                    if (mentionToken && !e.shiftKey) {
                      if (e.key === 'Escape') { e.preventDefault(); setMentionToken(null); return; }
                      if (mentionSuggestions.length) {
                        if (e.key === 'ArrowDown') { e.preventDefault(); setMentionActiveIndex(p => Math.min(p + 1, mentionSuggestions.length - 1)); return; }
                        if (e.key === 'ArrowUp') { e.preventDefault(); setMentionActiveIndex(p => Math.max(0, p - 1)); return; }
                        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMentionSuggestion(mentionSuggestions[mentionActiveIndex].fullPath); return; }
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey && !sending && !canceling) {
                      e.preventDefault(); void send();
                    }
                  }}
                />
              </div>

              {/* Toolbar Actions */}
              <div className="flex items-center justify-between px-3 pb-3">
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-8 rounded-lg text-muted-foreground hover:bg-background/80 hover:text-foreground transition-all"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImageIcon className="size-4.5" />
                  </Button>
                  
                  <div className="h-4 w-px bg-border/40 mx-1" />

                  <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 px-2.5 gap-1.5 rounded-lg text-[11px] font-bold text-muted-foreground hover:bg-background/80 uppercase tracking-tight transition-all">
                        {modelSelection ? modelSelection.model : project.model || '选择模型'}
                        <ChevronDown className="size-3" />
                      </Button>
                    </PopoverTrigger>
                    {/* Popover content remains mostly same but with ChatGPT styling */}
                    <PopoverContent align="start" className="w-[280px] p-1.5 rounded-xl shadow-2xl border-border/40 backdrop-blur-xl">
                       <Input 
                         value={modelPickerQuery} 
                         onChange={(e) => setModelPickerQuery(e.target.value)}
                         placeholder="搜索模型..." 
                         className="h-9 mb-1.5 rounded-lg border-none bg-muted/50 focus-visible:ring-1 focus-visible:ring-primary/20" 
                       />
                       <div className="max-h-[300px] overflow-auto custom-scrollbar">
                          {/* List items ... */}
                          <Button 
                            variant="ghost" size="sm" 
                            className="w-full justify-start gap-2 mb-1 rounded-lg"
                            onClick={() => { setModelSelection(null); setModelPickerOpen(false); }}
                          >
                            <div className="size-2 rounded-full bg-primary/40 mr-1" />
                            <span className="text-xs font-medium">项目默认 {project.model && `(${project.model})`}</span>
                          </Button>
                          {/* Mapping providers and models ... */}
                          {modelPickerProviderGroups.map(g => (
                            <div key={g.provider.id} className="mb-2">
                              <div className="px-2 py-1 text-[10px] font-bold text-muted-foreground/60 uppercase tracking-widest">{g.provider.name}</div>
                              {g.models.map(m => (
                                <Button 
                                  key={m} 
                                  variant="ghost" 
                                  size="sm" 
                                  className={cn("w-full justify-start gap-2 rounded-lg text-xs", modelSelection?.model === m && "bg-primary/5 text-primary")}
                                  onClick={() => { setModelSelection({ providerId: g.provider.id, model: m }); setModelPickerOpen(false); }}
                                >
                                  {m}
                                </Button>
                              ))}
                            </div>
                          ))}
                       </div>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="flex items-center gap-2">
                  {sending ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 px-3 rounded-xl border-border/40 shadow-sm hover:bg-destructive/10 hover:text-destructive transition-all"
                      onClick={() => void cancel()}
                      disabled={canceling}
                    >
                      <Spinner className="size-3.5" />
                      <span className="text-xs font-semibold">{canceling ? '正在停止' : '停止'}</span>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className={cn(
                        "h-8 px-4 rounded-xl font-bold transition-all shadow-md",
                        draft.trim() ? "bg-primary hover:scale-[1.02]" : "bg-muted-foreground/20 text-muted-foreground"
                      )}
                      onClick={() => void send()}
                      disabled={!draft.trim() && draftImages.length === 0}
                    >
                      发送
                    </Button>
                  )}
                </div>
              </div>

              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addDraftImages(Array.from(e.target.files ?? []))} />
            </div>

            {/* Sub-footer note */}
            <div className="mt-2 text-center">
              <span className="text-[10px] text-muted-foreground/50 tracking-wide font-medium">
                Codex 可能在编写代码时产生幻觉，请务必在运行前核对重要信息。
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Modals and Portals */}
      <Modal open={addModelOpen} title="添加模型" onClose={() => setAddModelOpen(false)} className="rounded-2xl border-none shadow-2xl backdrop-blur-xl">
        <div className="space-y-4 pt-2">
          {/* Add model form ... */}
        </div>
      </Modal>

      {detailsOpen && detailsPortalTarget && createPortal(
        <div className="h-full flex flex-col bg-muted/5">
          {/* Tool Output / Log View ... */}
        </div>,
        detailsPortalTarget
      )}
    </TooltipProvider>
  )
}

