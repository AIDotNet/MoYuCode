import { useMemo } from 'react'
import { cn } from '@/lib/utils'

export type DiffViewMode = 'split' | 'unified'

type DiffOpType = 'context' | 'add' | 'del'

type DiffOp = {
  kind: 'op'
  type: DiffOpType
  oldLine: number | null
  newLine: number | null
  text: string
}

type DiffMeta = { kind: 'meta' | 'hunk'; text: string }

type ParsedLine = DiffOp | DiffMeta

type SideLine = { lineNumber: number | null; text: string; type: DiffOpType }

type SplitRow =
  | { kind: 'meta' | 'hunk'; text: string }
  | { kind: 'row'; left: SideLine | null; right: SideLine | null }

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line)
  if (!match) return null
  return { oldStart: Number(match[1]), newStart: Number(match[2]) }
}

function parseDiff(diff: string): ParsedLine[] {
  const lines = (diff ?? '').replace(/\r\n/g, '\n').split('\n')
  const parsed: ParsedLine[] = []
  let inHunk = false
  let oldLine = 0
  let newLine = 0

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const header = parseHunkHeader(raw)
      if (header) {
        inHunk = true
        oldLine = header.oldStart
        newLine = header.newStart
      }
      parsed.push({ kind: 'hunk', text: raw })
      continue
    }

    if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      inHunk = false
      parsed.push({ kind: 'meta', text: raw })
      continue
    }

    if (!inHunk) {
      if (!raw.trim()) continue
      parsed.push({ kind: 'meta', text: raw })
      continue
    }

    const prefix = raw[0]
    const text = raw.slice(1)
    if (prefix === ' ') {
      parsed.push({ kind: 'op', type: 'context', oldLine, newLine, text })
      oldLine += 1
      newLine += 1
      continue
    }

    if (prefix === '-') {
      parsed.push({ kind: 'op', type: 'del', oldLine, newLine: null, text })
      oldLine += 1
      continue
    }

    if (prefix === '+') {
      parsed.push({ kind: 'op', type: 'add', oldLine: null, newLine, text })
      newLine += 1
      continue
    }

    parsed.push({ kind: 'meta', text: raw })
  }

  return parsed
}

function toSplitRows(lines: ParsedLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let pendingDels: DiffOp[] = []
  let pendingAdds: DiffOp[] = []

  const flush = () => {
    if (!pendingDels.length && !pendingAdds.length) return
    const count = Math.max(pendingDels.length, pendingAdds.length)
    for (let i = 0; i < count; i += 1) {
      const del = pendingDels[i] ?? null
      const add = pendingAdds[i] ?? null
      rows.push({
        kind: 'row',
        left: del ? { lineNumber: del.oldLine, text: del.text, type: 'del' } : null,
        right: add ? { lineNumber: add.newLine, text: add.text, type: 'add' } : null,
      })
    }
    pendingDels = []
    pendingAdds = []
  }

  for (const line of lines) {
    if (line.kind === 'op') {
      if (line.type === 'del') {
        pendingDels.push(line)
        continue
      }

      if (line.type === 'add') {
        pendingAdds.push(line)
        continue
      }

      flush()
      rows.push({
        kind: 'row',
        left: { lineNumber: line.oldLine, text: line.text, type: 'context' },
        right: { lineNumber: line.newLine, text: line.text, type: 'context' },
      })
      continue
    }

    flush()
    rows.push(line)
  }

  flush()
  return rows
}

function rowBg(type: DiffOpType | null): string {
  if (type === 'add') return 'bg-emerald-500/15'
  if (type === 'del') return 'bg-rose-500/15'
  return ''
}

function metaBg(kind: 'meta' | 'hunk'): string {
  return kind === 'hunk' ? 'bg-muted/30 text-muted-foreground' : 'bg-muted/20 text-muted-foreground'
}

function renderCodeCell(side: SideLine | null) {
  return (
    <>
      <span className="w-12 shrink-0 select-none pr-2 text-right text-muted-foreground/70">
        {side?.lineNumber ?? ''}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre">{side?.text ?? ''}</span>
    </>
  )
}

export function DiffViewer({
  diff,
  viewMode,
  className,
}: {
  diff: string
  viewMode: DiffViewMode
  className?: string
}) {
  const parsed = useMemo(() => parseDiff(diff), [diff])
  const splitRows = useMemo(() => toSplitRows(parsed), [parsed])

  if (!diff.trim()) {
    return <div className={cn('px-4 py-4 text-xs text-muted-foreground', className)}>（无 diff）</div>
  }

  if (viewMode === 'unified') {
    return (
      <div className={cn('h-full min-h-0 overflow-auto font-mono text-xs', className)}>
        <div className="min-w-fit">
          {parsed.map((line, idx) => {
            if (line.kind !== 'op') {
              return (
                <div
                  key={`${line.kind}-${idx}`}
                  className={cn('px-3 py-1 whitespace-pre', metaBg(line.kind))}
                >
                  {line.text}
                </div>
              )
            }

            const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
            return (
              <div
                key={`op-${idx}`}
                className={cn('grid grid-cols-[3rem_3rem_1.5rem_1fr] px-3 py-0.5', rowBg(line.type))}
              >
                <span className="select-none text-right text-muted-foreground/70">{line.oldLine ?? ''}</span>
                <span className="select-none text-right text-muted-foreground/70">{line.newLine ?? ''}</span>
                <span className="select-none text-muted-foreground/70">{marker}</span>
                <span className="min-w-0 whitespace-pre">{line.text}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('h-full min-h-0 overflow-auto font-mono text-xs', className)}>
      <div className="sticky top-0 z-10 grid grid-cols-2 border-b bg-card/80 backdrop-blur">
        <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground">Original</div>
        <div className="border-l px-3 py-2 text-[11px] font-medium text-muted-foreground">Modified</div>
      </div>

      <div className="min-w-fit">
        {splitRows.map((row, idx) => {
          if (row.kind !== 'row') {
            return (
              <div
                key={`${row.kind}-${idx}`}
                className={cn('px-3 py-1 whitespace-pre', metaBg(row.kind))}
              >
                {row.text}
              </div>
            )
          }

          return (
            <div key={`row-${idx}`} className="grid grid-cols-2">
              <div className={cn('flex px-3 py-0.5', rowBg(row.left?.type ?? null))}>
                {renderCodeCell(row.left)}
              </div>
              <div
                className={cn(
                  'flex border-l px-3 py-0.5',
                  rowBg(row.right?.type ?? null),
                )}
              >
                {renderCodeCell(row.right)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

