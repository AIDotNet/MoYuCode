import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, formatUtc } from '@/api/client'
import type { ProjectDto, ProjectSessionDto, SessionTokenUsageDto } from '@/api/types'
import { SessionTraceBar, TokenUsageColumnChart } from '@/components/CodexSessionViz'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

type SessionsCacheEntry = {
  cachedAt: number
  sessions: ProjectSessionDto[]
}

const sessionsCache = new Map<string, SessionsCacheEntry>()
const sessionsCacheTtlMs = 60_000

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

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  return `${(ratio * 100).toFixed(1)}%`
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)

  if (hours > 0) return `${hours}小时${minutes}分`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

function traceKindLabel(kind: string): string {
  switch (kind) {
    case 'tool':
      return '工具'
    case 'think':
      return '思考'
    case 'gen':
      return '生成'
    case 'waiting':
      return '等待'
    default:
      return kind
  }
}

export function ProjectSessionsView({
  project,
  onBack,
}: {
  project: ProjectDto
  onBack: () => void
}) {
  const toolLabel = project.toolType === 'Codex' ? 'Codex' : 'Claude Code'

  const [sessions, setSessions] = useState<ProjectSessionDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapseWaiting, setCollapseWaiting] = useState(true)
  const [waitingClampMs, setWaitingClampMs] = useState(30_000)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  const load = useCallback(
    async ({ force }: { force?: boolean } = {}) => {
      const cached = sessionsCache.get(project.id)
      const isCacheFresh =
        cached && Date.now() - cached.cachedAt < sessionsCacheTtlMs

      if (!force && cached && isCacheFresh) {
        setError(null)
        setSessions(cached.sessions)
        setSelectedSessionId((current) => {
          if (!current) return current
          return cached.sessions.some((s) => s.id === current) ? current : null
        })
        return
      }

      setLoading(true)
      setError(null)
      try {
        const data = await api.projects.sessions(project.id)
        const filtered = data.filter((s) => s.durationMs > 0)
        sessionsCache.set(project.id, { cachedAt: Date.now(), sessions: filtered })
        setSessions(filtered)
        setSelectedSessionId((current) => {
          if (!current) return current
          return filtered.some((s) => s.id === current) ? current : null
        })
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [project.id],
  )

  useEffect(() => {
    void load()
  }, [load])

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null
    return sessions.find((s) => s.id === selectedSessionId) ?? null
  }, [selectedSessionId, sessions])

  const selectedSessionTotals = useMemo(() => {
    if (!selectedSession) return null

    const trace = selectedSession.trace ?? []
    const totalTraceMs =
      selectedSession.durationMs > 0
        ? selectedSession.durationMs
        : trace.reduce((acc, span) => acc + (span.durationMs || 0), 0)

    const traceTotals: Record<
      string,
      { durationMs: number; tokenCount: number; eventCount: number }
    > = {}

    for (const span of trace) {
      const kind = span.kind
      const cur = traceTotals[kind] ?? {
        durationMs: 0,
        tokenCount: 0,
        eventCount: 0,
      }
      cur.durationMs += span.durationMs || 0
      cur.tokenCount += span.tokenCount || 0
      cur.eventCount += span.eventCount || 0
      traceTotals[kind] = cur
    }

    const traceKinds = [
      { key: 'tool', eventLabel: '工具', showTokens: false },
      { key: 'think', eventLabel: '模型', showTokens: true },
      { key: 'gen', eventLabel: '模型', showTokens: true },
      { key: 'waiting', eventLabel: null, showTokens: false },
    ] as const

    return { trace, totalTraceMs, traceTotals, traceKinds }
  }, [selectedSession])

  const sessionTotalTokens = useCallback((s: ProjectSessionDto) => {
    return (
      (s.tokenUsage?.inputTokens ?? 0) +
      (s.tokenUsage?.cachedInputTokens ?? 0) +
      (s.tokenUsage?.outputTokens ?? 0) +
      (s.tokenUsage?.reasoningOutputTokens ?? 0)
    )
  }, [])

  const projectTokenUsage: SessionTokenUsageDto = useMemo(() => {
    const totals: SessionTokenUsageDto = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    }

    for (const s of sessions) {
      totals.inputTokens += s.tokenUsage?.inputTokens ?? 0
      totals.cachedInputTokens += s.tokenUsage?.cachedInputTokens ?? 0
      totals.outputTokens += s.tokenUsage?.outputTokens ?? 0
      totals.reasoningOutputTokens += s.tokenUsage?.reasoningOutputTokens ?? 0
    }

    return totals
  }, [sessions])

  const projectTotalTokens = useMemo(() => {
    return (
      projectTokenUsage.inputTokens +
      projectTokenUsage.cachedInputTokens +
      projectTokenUsage.outputTokens +
      projectTokenUsage.reasoningOutputTokens
    )
  }, [projectTokenUsage])

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onBack}>
              返回
            </Button>
            <div className="text-sm font-medium">
              {project.name}：会话
            </div>
            {loading ? <Spinner /> : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            扫描本机 {toolLabel} sessions 并按创建时间排序。
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void load({ force: true })}
          disabled={loading}
        >
          刷新
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-medium">
              会话列表 {sessions.length ? `（${sessions.length}）` : ''}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={collapseWaiting}
                  onChange={(e) => setCollapseWaiting(e.target.checked)}
                />
                折叠空闲
              </label>
              <label className="inline-flex items-center gap-2">
                <span>阈值</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={waitingClampMs}
                  disabled={!collapseWaiting}
                  onChange={(e) => setWaitingClampMs(Number(e.target.value))}
                >
                  <option value={10_000}>10秒</option>
                  <option value={30_000}>30秒</option>
                  <option value={60_000}>1分钟</option>
                  <option value={300_000}>5分钟</option>
                </select>
              </label>
            </div>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            折叠只影响显示宽度；鼠标移入可查看真实时长与占比。
          </div>
        </div>
        <div className="p-4">
          {sessions.length ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  选择会话
                </div>
                <div className="max-h-[560px] overflow-auto rounded-md border bg-background/30">
                  <div className="space-y-1 p-1">
                    {sessions.map((s) => {
                      const isActive = s.id === selectedSessionId
                      const totalTokens = sessionTotalTokens(s)
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={cn(
                            'w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors',
                            'hover:bg-accent/40',
                            isActive
                              ? 'border-border bg-accent/40'
                              : 'bg-transparent',
                          )}
                          onClick={() => setSelectedSessionId(s.id)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">
                                {formatUtc(s.createdAtUtc)}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {s.id}
                              </div>
                            </div>
                            <div className="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                              <div>{formatDuration(s.durationMs)}</div>
                              <div title={`总计 ${formatNumber(totalTokens)} Token`}>
                                {formatCompactNumber(totalTokens)} Token
                              </div>
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  选择后在右侧查看统计图表与时间线。
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-lg border bg-muted/10 p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-sm font-medium">项目汇总</div>
                    <div
                      className="text-xs text-muted-foreground tabular-nums"
                      title={`总计 ${formatNumber(projectTotalTokens)} Token`}
                    >
                      {formatCompactNumber(projectTotalTokens)} Token
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    汇总当前项目内所有会话的 Token（输入 / 缓存 / 输出 / 思考）。
                  </div>
                  <div className="mt-3">
                    <TokenUsageColumnChart usage={projectTokenUsage} />
                  </div>
                </div>

                {selectedSession && selectedSessionTotals ? (
                  <div className="rounded-lg border bg-muted/10 p-4">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_22rem_1fr]">
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          信息
                        </div>
                        <div className="space-y-1">
                          <div className="text-sm font-medium">
                            {formatUtc(selectedSession.createdAtUtc)}
                          </div>
                          <div className="break-all text-xs text-muted-foreground">
                            {selectedSession.id}
                          </div>
                          <div className="text-xs">
                            时长：{formatDuration(selectedSession.durationMs)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            结束：{formatUtc(selectedSession.lastEventAtUtc)}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="text-xs font-medium text-muted-foreground">
                          统计信息
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                          <div>
                            消息: {formatNumber(selectedSession.eventCounts.message)}
                          </div>
                          <div>
                            工具调用:{' '}
                            {formatNumber(selectedSession.eventCounts.functionCall)}
                          </div>
                          <div>
                            推理: {formatNumber(selectedSession.eventCounts.agentReasoning)}
                          </div>
                          <div>
                            token_count:{' '}
                            {formatNumber(selectedSession.eventCounts.tokenCount)}
                          </div>
                          <div>其他: {formatNumber(selectedSession.eventCounts.other)}</div>
                        </div>

                        <TokenUsageColumnChart usage={selectedSession.tokenUsage} />

                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                          <div
                            title={`输入 ${formatNumber(selectedSession.tokenUsage.inputTokens)}`}
                          >
                            输入: {formatCompactNumber(selectedSession.tokenUsage.inputTokens)}
                          </div>
                          <div
                            title={`缓存 ${formatNumber(selectedSession.tokenUsage.cachedInputTokens)}`}
                          >
                            缓存:{' '}
                            {formatCompactNumber(selectedSession.tokenUsage.cachedInputTokens)}
                          </div>
                          <div
                            title={`输出 ${formatNumber(selectedSession.tokenUsage.outputTokens)}`}
                          >
                            输出: {formatCompactNumber(selectedSession.tokenUsage.outputTokens)}
                          </div>
                          <div
                            title={`思考 ${formatNumber(selectedSession.tokenUsage.reasoningOutputTokens)}`}
                          >
                            思考:{' '}
                            {formatCompactNumber(selectedSession.tokenUsage.reasoningOutputTokens)}
                          </div>
                        </div>

                        {selectedSessionTotals.trace.length ? (
                          <div className="rounded-md border bg-background/40 p-2">
                            <div className="text-[11px] font-medium text-muted-foreground">
                              时间线分析
                            </div>
                            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                              {selectedSessionTotals.traceKinds.map((k) => {
                                const t = selectedSessionTotals.traceTotals[k.key] ?? {
                                  durationMs: 0,
                                  tokenCount: 0,
                                  eventCount: 0,
                                }
                                const percent =
                                  selectedSessionTotals.totalTraceMs > 0
                                    ? t.durationMs / selectedSessionTotals.totalTraceMs
                                    : 0

                                const parts = [
                                  `${traceKindLabel(k.key)}：${formatDuration(t.durationMs)}（${formatPercent(percent)}）`,
                                  k.showTokens && t.tokenCount > 0
                                    ? `${formatCompactNumber(t.tokenCount)} Token`
                                    : null,
                                  k.eventLabel && t.eventCount > 0
                                    ? `${formatCompactNumber(t.eventCount)} 次${k.eventLabel}`
                                    : null,
                                ].filter(Boolean)

                                return (
                                  <div key={k.key} title={parts.join(' · ')}>
                                    {parts.join(' · ')}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          时间线
                        </div>
                        <SessionTraceBar
                          trace={selectedSession.trace ?? []}
                          durationMs={selectedSession.durationMs}
                          collapseWaiting={collapseWaiting}
                          waitingClampMs={waitingClampMs}
                        />
                        <div className="text-[11px] text-muted-foreground">
                          鼠标移入色块：类型 / Token / 工具或模型次数 / 时长 / 占比（折叠等待会显示真实/显示）。
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border bg-muted/10 p-4 text-sm text-muted-foreground">
                    请选择左侧会话以查看 Token 统计图表与时间线。
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-6 text-sm text-muted-foreground">
              {loading ? '扫描中…' : '未找到会话。'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
