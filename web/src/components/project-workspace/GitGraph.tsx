import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

type GitGraphRow =
  | {
      kind: 'commit'
      raw: string
      graph: string
      hash: string
      refs: string[]
      subject: string
    }
  | {
      kind: 'connector'
      raw: string
      graph: string
    }

const laneColors = ['#61afef', '#e06c75', '#98c379', '#c678dd', '#e5c07b', '#56b6c2']

const charWidthPx = 8
const commitRowHeightPx = 20
const connectorRowHeightPx = 12
const strokeWidth = 2

function getLaneIndex(charIndex: number): number {
  return Math.floor(charIndex / 2)
}

function getLaneColor(laneIndex: number): string {
  return laneColors[laneIndex % laneColors.length]
}

function isHexHash(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value)
}

function parseRefsAndSubject(afterHash: string): { refs: string[]; subject: string } {
  const trimmed = afterHash.trim()
  if (!trimmed) return { refs: [], subject: '' }

  const match = /^\(([^)]+)\)\s*(.*)$/.exec(trimmed)
  if (!match) return { refs: [], subject: trimmed }

  const refs = match[1]
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean)

  return { refs, subject: match[2]?.trim() ?? '' }
}

function parseGitGraphLines(lines: string[]): GitGraphRow[] {
  return lines.map((line) => {
    const hashMatch = /[0-9a-f]{7,40}/i.exec(line)
    if (!hashMatch || hashMatch.index === undefined) {
      return { kind: 'connector', raw: line, graph: line }
    }

    const hash = hashMatch[0]
    if (!isHexHash(hash)) {
      return { kind: 'connector', raw: line, graph: line }
    }

    const graph = line.slice(0, hashMatch.index)
    const after = line.slice(hashMatch.index + hash.length).trimStart()
    const { refs, subject } = parseRefsAndSubject(after)

    return {
      kind: 'commit',
      raw: line,
      graph,
      hash,
      refs,
      subject,
    }
  })
}

function classifyRef(ref: string): 'head' | 'tag' | 'remote' | 'local' {
  if (ref.includes('HEAD ->') || ref.startsWith('HEAD')) return 'head'
  if (ref.startsWith('tag:')) return 'tag'
  if (ref.includes('/')) return 'remote'
  return 'local'
}

function formatRefLabel(ref: string): string {
  const trimmed = ref.trim()
  const headArrowIndex = trimmed.indexOf('HEAD ->')
  if (headArrowIndex >= 0) {
    return trimmed.slice(headArrowIndex + 'HEAD ->'.length).trim() || 'HEAD'
  }

  if (trimmed.startsWith('tag:')) {
    return trimmed.slice('tag:'.length).trim()
  }

  return trimmed
}

function getGraphWidthChars(rows: GitGraphRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.graph.trimEnd().length), 0)
}

function idxToX(idx: number): number {
  return idx * charWidthPx + charWidthPx / 2
}

function GraphSvg({
  graph,
  widthChars,
  heightPx,
}: {
  graph: string
  widthChars: number
  heightPx: number
}) {
  const padded = graph.padEnd(widthChars, ' ')
  const y0 = 0
  const y1 = heightPx
  const yMid = heightPx / 2

  const starIndex = padded.indexOf('*')

  const segments: Array<{
    x1: number
    y1: number
    x2: number
    y2: number
    color: string
    opacity?: number
  }> = []

  for (let i = 0; i < widthChars; i += 1) {
    const ch = padded[i] ?? ' '
    if (ch === ' ') continue

    const laneColor = getLaneColor(getLaneIndex(i))

    if (ch === '|' || ch === '*') {
      segments.push({ x1: idxToX(i), y1: y0, x2: idxToX(i), y2: y1, color: laneColor, opacity: 0.9 })
      continue
    }

    if (ch === '\\') {
      const start = i - 1
      const end = i + 1
      if (start >= 0 && end < widthChars) {
        segments.push({
          x1: idxToX(start),
          y1: y0,
          x2: idxToX(end),
          y2: y1,
          color: getLaneColor(getLaneIndex(start)),
          opacity: 0.85,
        })
      }
      continue
    }

    if (ch === '/') {
      const start = i + 1
      const end = i - 1
      if (end >= 0 && start < widthChars) {
        segments.push({
          x1: idxToX(start),
          y1: y0,
          x2: idxToX(end),
          y2: y1,
          color: getLaneColor(getLaneIndex(start)),
          opacity: 0.85,
        })
      }
      continue
    }

    if (ch === '-' || ch === '_') {
      const start = i - 1
      const end = i + 1
      if (start >= 0 && end < widthChars) {
        segments.push({
          x1: idxToX(start),
          y1: yMid,
          x2: idxToX(end),
          y2: yMid,
          color: getLaneColor(getLaneIndex(start)),
          opacity: 0.7,
        })
      }
      continue
    }
  }

  const node =
    starIndex >= 0
      ? {
          cx: idxToX(starIndex),
          cy: yMid,
          color: getLaneColor(getLaneIndex(starIndex)),
        }
      : null

  return (
    <svg
      width={widthChars * charWidthPx}
      height={heightPx}
      viewBox={`0 0 ${widthChars * charWidthPx} ${heightPx}`}
      className="block"
      aria-hidden="true"
      focusable="false"
    >
      {segments.map((seg, idx) => (
        <line
          key={idx}
          x1={seg.x1}
          y1={seg.y1}
          x2={seg.x2}
          y2={seg.y2}
          stroke={seg.color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          opacity={seg.opacity ?? 1}
        />
      ))}

      {node ? (
        <circle
          cx={node.cx}
          cy={node.cy}
          r={5}
          fill="transparent"
          stroke={node.color}
          strokeWidth={strokeWidth}
        />
      ) : null}
    </svg>
  )
}

export function GitGraph({
  lines,
  className,
}: {
  lines: string[]
  className?: string
}) {
  const rows = useMemo(() => parseGitGraphLines(lines ?? []), [lines])

  const graphWidthChars = useMemo(() => getGraphWidthChars(rows), [rows])

  if (!rows.length) {
    return <div className={cn('px-3 py-2 text-xs text-muted-foreground', className)}>No commits</div>
  }

  return (
    <div className={cn('min-w-fit text-[12px] leading-relaxed', className)}>
      {rows.map((row, idx) => {
        if (row.kind === 'connector') {
          return (
            <div key={`${idx}:${row.raw}`} className="flex items-center gap-2 px-2 py-0.5 opacity-80">
              <div className="shrink-0" style={{ width: graphWidthChars * charWidthPx }}>
                <GraphSvg
                  graph={row.graph}
                  widthChars={graphWidthChars}
                  heightPx={connectorRowHeightPx}
                />
              </div>
            </div>
          )
        }

        return (
          <div
            key={`${idx}:${row.hash}`}
            className={cn(
              'flex items-center gap-2 px-2 py-1',
              'rounded-md transition-colors hover:bg-accent/40',
            )}
            title={row.raw}
            role="button"
            tabIndex={0}
            onClick={() => {
              void navigator.clipboard?.writeText?.(row.hash)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void navigator.clipboard?.writeText?.(row.hash)
              }
            }}
          >
            <div className="shrink-0" style={{ width: graphWidthChars * charWidthPx }}>
              <GraphSvg graph={row.graph} widthChars={graphWidthChars} heightPx={commitRowHeightPx} />
            </div>

            <div className="min-w-0 flex-1 flex items-center gap-2">
              {row.refs.length ? (
                <div className="shrink-0 flex flex-wrap items-center gap-1">
                  {row.refs.map((ref) => {
                    const kind = classifyRef(ref)
                    const variant = kind === 'head' ? 'default' : kind === 'tag' ? 'secondary' : 'outline'
                    const label = formatRefLabel(ref)
                    return (
                      <Badge
                        key={ref}
                        variant={variant}
                        className={cn(
                          'px-1.5 py-0 text-[10px]',
                          variant === 'default' ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30' : '',
                        )}
                        title={ref}
                      >
                        {label}
                      </Badge>
                    )
                  })}
                </div>
              ) : null}

              <div className="min-w-0 flex-1 truncate text-xs">
                {row.subject || <span className="text-muted-foreground">（no message）</span>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
