import { useMemo } from 'react'
import type {
  CodexDailyTokenUsageDto,
  SessionTraceSpanDto,
  SessionTokenUsageDto,
} from '@/api/types'
import { cn } from '@/lib/utils'

type TraceKind = 'tool' | 'waiting' | 'think' | 'gen'

type TraceSegment = SessionTraceSpanDto & { startMs: number; endMs: number }

function safeNumber(value: number | null | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString()
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

function kindLabel(kind: string): string {
  switch (kind) {
    case 'tool':
      return '工具'
    case 'think':
      return '思考'
    case 'waiting':
      return '等待'
    case 'gen':
      return '生成'
    default:
      return kind
  }
}

const kindColor: Record<TraceKind, string> = {
  tool: 'bg-foreground/85',
  waiting: 'bg-muted-foreground/30',
  think: 'bg-emerald-500/90',
  gen: 'bg-amber-500/90',
}

function getKindColor(kind: string): string {
  if (kind === 'tool') return kindColor.tool
  if (kind === 'waiting') return kindColor.waiting
  if (kind === 'think') return kindColor.think
  if (kind === 'gen') return kindColor.gen
  return kindColor.waiting
}

function formatDurationTrace(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0s'
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${seconds}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h${mins}m`
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  return `${(ratio * 100).toFixed(1)}%`
}

function buildTraceSegments(trace: SessionTraceSpanDto[]): TraceSegment[] {
  let cursor = 0
  const segments: TraceSegment[] = []

  for (const span of trace) {
    const durationMs = safeNumber(span.durationMs)
    const tokenCount = safeNumber(span.tokenCount)
    const eventCount = safeNumber(span.eventCount)
    if (!durationMs) continue

    const startMs = cursor
    cursor += durationMs
    segments.push({
      kind: span.kind,
      durationMs,
      tokenCount,
      eventCount,
      startMs,
      endMs: cursor,
    })
  }

  return segments
}

function pickTokenUnit(totalTokens: number): number {
  const abs = Math.max(0, Math.floor(Math.abs(totalTokens)))
  if (!abs) return 1

  const candidates = [
    1,
    10,
    50,
    100,
    250,
    500,
    1000,
    2000,
    5000,
    10000,
    20000,
    50000,
    100000,
    200000,
    500000,
    1000000,
  ]

  for (const u of candidates) {
    if (abs / u <= 32) return u
  }
  return 1000000
}

export function SessionTraceBar({
  trace,
  durationMs,
  className,
  collapseWaiting = false,
  waitingClampMs = 30_000,
}: {
  trace: SessionTraceSpanDto[]
  durationMs: number
  className?: string
  collapseWaiting?: boolean
  waitingClampMs?: number
}) {
  const totalDurationMs = useMemo(() => {
    const fromProp = safeNumber(durationMs)
    if (fromProp > 0) return fromProp
    return trace.reduce((acc, s) => acc + safeNumber(s.durationMs), 0)
  }, [durationMs, trace])

  const segments = useMemo(() => buildTraceSegments(trace), [trace])
  const displaySegments = useMemo(() => {
    const clamp = Math.max(0, safeNumber(waitingClampMs))
    return segments.map((seg) => {
      const collapsed =
        collapseWaiting &&
        seg.kind === 'waiting' &&
        clamp > 0 &&
        seg.durationMs > clamp
      const displayDurationMs = collapsed ? clamp : seg.durationMs
      return { ...seg, displayDurationMs, collapsed }
    })
  }, [collapseWaiting, segments, waitingClampMs])

  const displayTotalDurationMs = useMemo(() => {
    return displaySegments.reduce((acc, seg) => acc + seg.displayDurationMs, 0)
  }, [displaySegments])

  const collapsedWaitingCount = useMemo(() => {
    return displaySegments.reduce((acc, seg) => acc + (seg.collapsed ? 1 : 0), 0)
  }, [displaySegments])

  if (!segments.length || totalDurationMs <= 0) {
    return <div className="text-xs text-muted-foreground">—</div>
  }

  const legend = [
    { key: 'tool', label: '工具' },
    { key: 'think', label: '思考' },
    { key: 'gen', label: '生成' },
    { key: 'waiting', label: '等待' },
  ] as const

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="text-xs font-medium text-foreground">时间线</span>
          {legend.map((x) => (
            <span key={x.key} className="inline-flex items-center gap-1">
              <span
                className={cn('inline-block size-2 rounded-sm', getKindColor(x.key))}
              />
              <span>{x.label}</span>
            </span>
          ))}
          {collapseWaiting && collapsedWaitingCount > 0 ? (
            <span
              className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={`已折叠 ${collapsedWaitingCount} 段等待（阈值 ${formatDurationTrace(waitingClampMs)}）`}
            >
              折叠空闲
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          <span>+0</span>
          <span>{formatDurationTrace(totalDurationMs)}</span>
        </div>
      </div>

      <div className="h-3 w-full overflow-hidden rounded bg-muted/30 ring-1 ring-border/50">
        <div className="flex h-full w-full">
          {displaySegments.map((seg, idx) => {
            const ratio = seg.durationMs / totalDurationMs
            const displayRatio =
              displayTotalDurationMs > 0 ? seg.displayDurationMs / displayTotalDurationMs : 0
            const eventLabel =
              seg.kind === 'tool'
                ? '次工具'
                : seg.kind === 'think' || seg.kind === 'gen'
                  ? '次模型'
                  : null
            const durationPart = seg.collapsed
              ? `真实 ${formatDurationTrace(seg.durationMs)} (${formatPercent(ratio)}) / 折叠显示 ${formatDurationTrace(seg.displayDurationMs)} (${formatPercent(displayRatio)})`
              : `${formatDurationTrace(seg.durationMs)} (${formatPercent(ratio)})`

            const titleParts = [
              `${kindLabel(seg.kind)}`,
              seg.tokenCount > 0 ? `${formatCompactNumber(seg.tokenCount)} Token` : null,
              seg.eventCount > 0 && eventLabel
                ? `${formatCompactNumber(seg.eventCount)} ${eventLabel}`
                : null,
              durationPart,
              `+${formatDurationTrace(seg.startMs)} → +${formatDurationTrace(seg.endMs)}`,
            ].filter(Boolean)
            const title = titleParts.join(' / ')

            return (
              <div
                key={idx}
                className={cn('h-full', getKindColor(seg.kind))}
                style={{ flexGrow: Math.max(1, seg.displayDurationMs), flexBasis: 0 }}
                title={title}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function TokenUsageBar({
  usage,
  className,
}: {
  usage: SessionTokenUsageDto
  className?: string
}) {
  const input = safeNumber(usage.inputTokens)
  const cached = safeNumber(usage.cachedInputTokens)
  const output = safeNumber(usage.outputTokens)
  const reasoning = safeNumber(usage.reasoningOutputTokens)
  const total = input + cached + output + reasoning

  const unit = useMemo(() => pickTokenUnit(total), [total])
  const units = total ? Math.ceil(Math.abs(total) / unit) : 0
  const maxBlocks = 32
  const shownBlocks = Math.min(units, maxBlocks)

  const title = [
    `总计 ${formatNumber(total)}`,
    `输入 ${formatNumber(input)}`,
    `缓存 ${formatNumber(cached)}`,
    `输出 ${formatNumber(output)}`,
    `推理 ${formatNumber(reasoning)}`,
  ].join(' / ')

  const segments = [
    { key: 'in', value: input, color: 'bg-emerald-500/90' },
    { key: 'cache', value: cached, color: 'bg-emerald-300/90' },
    { key: 'out', value: output, color: 'bg-sky-500/90' },
    { key: 'reason', value: reasoning, color: 'bg-amber-500/90' },
  ].filter((s) => s.value > 0)

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs text-muted-foreground">Token</div>
        <div className="text-xs font-medium tabular-nums">{formatCompactNumber(total)}</div>
      </div>

      <div
        className="h-2.5 w-full overflow-hidden rounded bg-muted/30 ring-1 ring-border/50"
        title={title}
      >
        <div className="flex h-full w-full">
          {segments.length ? (
            segments.map((s) => (
              <div
                key={s.key}
                className={s.color}
                style={{ flexGrow: s.value, flexBasis: 0 }}
                title={`${s.key} ${formatNumber(s.value)}`}
              />
            ))
          ) : (
            <div className="h-full w-full bg-muted/40" />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1" title={`1格≈${formatNumber(unit)} Token`}>
          {shownBlocks ? (
            Array.from({ length: shownBlocks }).map((_, idx) => (
              <div
                key={idx}
                className="h-2 w-1 rounded-sm bg-muted-foreground/30"
              />
            ))
          ) : (
            <div className="text-[11px] text-muted-foreground">—</div>
          )}
          {units > maxBlocks ? (
            <div className="ml-1 text-[11px] text-muted-foreground">
              +{formatCompactNumber(units - maxBlocks)}
            </div>
          ) : null}
        </div>
        <div className="text-[11px] text-muted-foreground">
          1格≈{formatCompactNumber(unit)} Token
        </div>
      </div>
    </div>
  )
}

export function TokenUsageColumnChart({
  usage,
  className,
}: {
  usage: SessionTokenUsageDto
  className?: string
}) {
  const input = safeNumber(usage.inputTokens)
  const cached = safeNumber(usage.cachedInputTokens)
  const output = safeNumber(usage.outputTokens)
  const reasoning = safeNumber(usage.reasoningOutputTokens)

  const segments = useMemo(
    () => [
      { key: 'in', label: '输入', value: input, color: 'bg-emerald-500/90' },
      { key: 'cache', label: '缓存', value: cached, color: 'bg-emerald-300/90' },
      { key: 'out', label: '输出', value: output, color: 'bg-sky-500/90' },
      { key: 'think', label: '思考', value: reasoning, color: 'bg-amber-500/90' },
    ],
    [cached, input, output, reasoning],
  )

  const max = useMemo(() => {
    return segments.reduce((acc, s) => Math.max(acc, s.value), 0)
  }, [segments])

  const total = useMemo(() => {
    return segments.reduce((acc, s) => acc + s.value, 0)
  }, [segments])

  const title = [
    `总计 ${formatNumber(total)}`,
    `输入 ${formatNumber(input)}`,
    `缓存 ${formatNumber(cached)}`,
    `输出 ${formatNumber(output)}`,
    `思考 ${formatNumber(reasoning)}`,
  ].join(' / ')

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs text-muted-foreground">Token（按类型）</div>
        <div className="text-xs font-medium tabular-nums">
          {formatCompactNumber(total)}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2" title={title}>
        {segments.map((seg) => {
          const ratio = max > 0 ? seg.value / max : 0
          const heightPercent =
            seg.value > 0 ? Math.max(2, ratio * 100) : 0

          return (
            <div key={seg.key} className="space-y-1">
              <div className="flex h-24 items-end rounded-md bg-muted/20 px-2 ring-1 ring-border/50">
                <div
                  className={cn('w-full rounded-sm', seg.color)}
                  style={{ height: `${heightPercent}%` }}
                  title={`${seg.label} ${formatNumber(seg.value)}`}
                />
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-[11px] text-muted-foreground">
                  {seg.label}
                </div>
                <div className="text-[11px] tabular-nums">
                  {formatCompactNumber(seg.value)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatDayLabel(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(5)
  return value
}

export function TokenUsageDailyChart({
  days,
  className,
}: {
  days: CodexDailyTokenUsageDto[]
  className?: string
}) {
  const items = useMemo(() => {
    return (days ?? []).map((d) => {
      const input = safeNumber(d.tokenUsage?.inputTokens)
      const cached = safeNumber(d.tokenUsage?.cachedInputTokens)
      const output = safeNumber(d.tokenUsage?.outputTokens)
      const reasoning = safeNumber(d.tokenUsage?.reasoningOutputTokens)
      const total = input + cached + output + reasoning

      const segments = [
        { key: 'in', label: '输入', value: input, color: 'bg-emerald-500/90' },
        { key: 'cache', label: '缓存', value: cached, color: 'bg-emerald-300/90' },
        { key: 'out', label: '输出', value: output, color: 'bg-sky-500/90' },
        { key: 'think', label: '思考', value: reasoning, color: 'bg-amber-500/90' },
      ]

      return {
        date: d.date,
        label: formatDayLabel(d.date),
        total,
        segments,
      }
    })
  }, [days])

  const maxTotal = useMemo(() => {
    return items.reduce((acc, d) => Math.max(acc, d.total), 0)
  }, [items])

  const legend = [
    { key: 'in', label: '输入', color: 'bg-emerald-500/90' },
    { key: 'cache', label: '缓存', color: 'bg-emerald-300/90' },
    { key: 'out', label: '输出', color: 'bg-sky-500/90' },
    { key: 'think', label: '思考', color: 'bg-amber-500/90' },
  ] as const

  if (!items.length) {
    return <div className="text-sm text-muted-foreground">暂无数据</div>
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="text-xs font-medium text-foreground">
          最近 {items.length} 天
        </span>
        {legend.map((x) => (
          <span key={x.key} className="inline-flex items-center gap-1">
            <span className={cn('inline-block size-2 rounded-sm', x.color)} />
            <span>{x.label}</span>
          </span>
        ))}
      </div>

      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))`,
        }}
      >
        {items.map((d) => {
          const heightPercent = maxTotal > 0 ? (d.total / maxTotal) * 100 : 0
          const barHeight = d.total > 0 ? Math.max(2, heightPercent) : 0

          const title = [
            d.date,
            `总计 ${formatNumber(d.total)}`,
            ...d.segments.map((s) => `${s.label} ${formatNumber(s.value)}`),
          ].join(' / ')

          return (
            <div key={d.date} className="space-y-1" title={title}>
              <div className="flex h-28 flex-col justify-end rounded-md bg-muted/20 px-2 ring-1 ring-border/50">
                <div className="w-full" style={{ height: `${barHeight}%` }}>
                  <div className="flex h-full flex-col-reverse overflow-hidden rounded-sm">
                    {d.segments.map((s) => {
                      if (s.value <= 0 || d.total <= 0) return null
                      const segPercent = (s.value / d.total) * 100
                      return (
                        <div
                          key={s.key}
                          className={s.color}
                          style={{ height: `${segPercent}%` }}
                        />
                      )
                    })}
                  </div>
                </div>
              </div>
              <div className="text-center text-[11px] text-muted-foreground tabular-nums">
                {d.label}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
