import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/api/client'
import type {
  CodexDailyTokenUsageDto,
  JobDto,
  ProjectDto,
  SessionTokenUsageDto,
  ToolKey,
  ToolStatusDto,
  ToolType,
} from '@/api/types'
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from '@/components/animate-ui/components/radix/tabs'
import { Button } from '@/components/ui/button'
import { ProjectsTab } from '@/pages/tabs/ProjectsTab'
import { ProjectSessionsView } from '@/pages/tabs/ProjectSessionsView'
import { TokenUsageBar, TokenUsageDailyChart } from '@/components/CodexSessionViz'

type TabKey = 'overview' | 'sessions' | 'projects'

const TOOL_USAGE_CACHE_TTL_MS = 2 * 60 * 1000
const TOOL_USAGE_CACHE_KEYS: Record<ToolType, string> = {
  Codex: 'onecode:codex:token-usage:total:v1',
  ClaudeCode: 'onecode:claude:token-usage:total:v1',
}

const TOOL_DAILY_USAGE_CACHE_TTL_MS = 2 * 60 * 1000
const TOOL_DAILY_USAGE_CACHE_KEYS: Record<ToolType, string> = {
  Codex: 'onecode:codex:token-usage:daily:7:v1',
  ClaudeCode: 'onecode:claude:token-usage:daily:7:v1',
}

type ToolTokenUsageCache = {
  cachedAt: number
  data: SessionTokenUsageDto
}

function readToolTokenUsageCache(toolType: ToolType): ToolTokenUsageCache | null {
  try {
    const raw = localStorage.getItem(TOOL_USAGE_CACHE_KEYS[toolType])
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ToolTokenUsageCache>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.cachedAt !== 'number') return null
    if (!parsed.data) return null
    return parsed as ToolTokenUsageCache
  } catch {
    return null
  }
}

function writeToolTokenUsageCache(toolType: ToolType, data: SessionTokenUsageDto) {
  try {
    const payload: ToolTokenUsageCache = { cachedAt: Date.now(), data }
    localStorage.setItem(TOOL_USAGE_CACHE_KEYS[toolType], JSON.stringify(payload))
  } catch {
    // ignore
  }
}

type ToolDailyTokenUsageCache = {
  cachedAt: number
  data: CodexDailyTokenUsageDto[]
}

function readToolDailyTokenUsageCache(
  toolType: ToolType,
): ToolDailyTokenUsageCache | null {
  try {
    const raw = localStorage.getItem(TOOL_DAILY_USAGE_CACHE_KEYS[toolType])
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ToolDailyTokenUsageCache>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.cachedAt !== 'number') return null
    if (!Array.isArray(parsed.data)) return null
    return parsed as ToolDailyTokenUsageCache
  } catch {
    return null
  }
}

function writeToolDailyTokenUsageCache(
  toolType: ToolType,
  data: CodexDailyTokenUsageDto[],
) {
  try {
    const payload: ToolDailyTokenUsageCache = { cachedAt: Date.now(), data }
    localStorage.setItem(
      TOOL_DAILY_USAGE_CACHE_KEYS[toolType],
      JSON.stringify(payload),
    )
  } catch {
    // ignore
  }
}

export function ToolPage({ tool, title }: { tool: ToolKey; title: string }) {
  const toolType: ToolType = tool === 'codex' ? 'Codex' : 'ClaudeCode'
  const toolLabel = toolType === 'Codex' ? 'Codex' : 'Claude Code'
  const [searchParams, setSearchParams] = useSearchParams()

  const [status, setStatus] = useState<ToolStatusDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installJob, setInstallJob] = useState<JobDto | null>(null)

  const [tokenUsage, setTokenUsage] =
    useState<SessionTokenUsageDto | null>(null)
  const [tokenUsageLoading, setTokenUsageLoading] = useState(false)
  const [tokenUsageError, setTokenUsageError] = useState<string | null>(null)
  const [dailyTokenUsage, setDailyTokenUsage] = useState<
    CodexDailyTokenUsageDto[] | null
  >(null)
  const [dailyTokenUsageLoading, setDailyTokenUsageLoading] =
    useState(false)
  const [dailyTokenUsageError, setDailyTokenUsageError] =
    useState<string | null>(null)

  const [sessionsProjects, setSessionsProjects] = useState<ProjectDto[]>([])
  const [sessionsProjectId, setSessionsProjectId] = useState<string | null>(null)
  const [sessionsProjectsLoading, setSessionsProjectsLoading] = useState(false)
  const [sessionsProjectsError, setSessionsProjectsError] = useState<string | null>(
    null,
  )

  const tabParam = searchParams.get('tab')

  const allowedTabs = useMemo(() => {
    const tabs: { key: TabKey; label: string }[] = [
      { key: 'overview', label: '首页' },
    ]

    if (status?.installed) {
      tabs.push({ key: 'sessions', label: '会话' })
    }

    if (status?.installed) {
      tabs.push({ key: 'projects', label: '项目管理' })
    }

    return tabs
  }, [status?.installed])

  const tab: TabKey = useMemo(() => {
    const isAllowed = allowedTabs.some((t) => t.key === tabParam)
    return isAllowed ? (tabParam as TabKey) : 'overview'
  }, [allowedTabs, tabParam])

  const setTab = useCallback(
    (next: TabKey) => {
      const sp = new URLSearchParams(searchParams)
      sp.set('tab', next)
      setSearchParams(sp, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.tools.status(tool)
      setStatus(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tool])

  const loadTokenUsage = useCallback(
    async (forceRefresh = false) => {
      setTokenUsageLoading(true)
      setTokenUsageError(null)
      try {
        const data =
          toolType === 'Codex'
            ? await api.tools.codexTokenUsage(forceRefresh)
            : await api.tools.claudeTokenUsage(forceRefresh)
        setTokenUsage(data)
        writeToolTokenUsageCache(toolType, data)
      } catch (e) {
        setTokenUsageError((e as Error).message)
      } finally {
        setTokenUsageLoading(false)
      }
    },
    [toolType],
  )

  const loadDailyTokenUsage = useCallback(
    async (forceRefresh = false) => {
      setDailyTokenUsageLoading(true)
      setDailyTokenUsageError(null)
      try {
        const data =
          toolType === 'Codex'
            ? await api.tools.codexTokenUsageDaily(7, forceRefresh)
            : await api.tools.claudeTokenUsageDaily(7, forceRefresh)
        setDailyTokenUsage(data)
        writeToolDailyTokenUsageCache(toolType, data)
      } catch (e) {
        setDailyTokenUsageError((e as Error).message)
      } finally {
        setDailyTokenUsageLoading(false)
      }
    },
    [toolType],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab !== 'overview') return
    if (!status?.installed) return

    const cached = readToolTokenUsageCache(toolType)
    const now = Date.now()
    const isFresh = cached ? now - cached.cachedAt <= TOOL_USAGE_CACHE_TTL_MS : false

    if (cached?.data) {
      setTokenUsage(cached.data)
    }

    if (!isFresh) {
      const t = window.setTimeout(() => {
        void loadTokenUsage(false)
      }, 0)
      return () => window.clearTimeout(t)
    }
  }, [loadTokenUsage, status?.installed, tab, toolType])

  useEffect(() => {
    if (tab !== 'overview') return
    if (!status?.installed) return

    const cached = readToolDailyTokenUsageCache(toolType)
    const now = Date.now()
    const isFresh = cached
      ? now - cached.cachedAt <= TOOL_DAILY_USAGE_CACHE_TTL_MS
      : false

    if (cached?.data) {
      setDailyTokenUsage(cached.data)
    }

    if (!isFresh) {
      const t = window.setTimeout(() => {
        void loadDailyTokenUsage(false)
      }, 0)
      return () => window.clearTimeout(t)
    }
  }, [loadDailyTokenUsage, status?.installed, tab, toolType])

  useEffect(() => {
    if (!status?.installed && (tab === 'projects' || tab === 'sessions')) {
      setTab('overview')
    }
  }, [setTab, status?.installed, tab])

  const loadSessionsProjects = useCallback(async () => {
    setSessionsProjectsLoading(true)
    setSessionsProjectsError(null)
    try {
      const projects = await api.projects.list(toolType)
      setSessionsProjects(projects)
      setSessionsProjectId((current) => {
        if (current && projects.some((p) => p.id === current)) return current
        return projects[0]?.id ?? null
      })
    } catch (e) {
      setSessionsProjectsError((e as Error).message)
    } finally {
      setSessionsProjectsLoading(false)
    }
  }, [toolType])

  useEffect(() => {
    if (tab !== 'sessions') return
    if (!status?.installed) return
    void loadSessionsProjects()
  }, [loadSessionsProjects, status?.installed, tab])

  const selectedSessionsProject = useMemo(() => {
    if (!sessionsProjectId) return null
    return sessionsProjects.find((p) => p.id === sessionsProjectId) ?? null
  }, [sessionsProjects, sessionsProjectId])

  useEffect(() => {
    if (!installJob) return
    if (installJob.status === 'Succeeded' || installJob.status === 'Failed') return

    const timer = window.setInterval(async () => {
      try {
        const latest = await api.jobs.get(installJob.id)
        setInstallJob(latest)
        if (latest.status === 'Succeeded' || latest.status === 'Failed') {
          await load()
        }
      } catch (e) {
        setError((e as Error).message)
      }
    }, 1200)

    return () => window.clearInterval(timer)
  }, [installJob, load])

  const install = async () => {
    setLoading(true)
    setError(null)
    try {
      const job = await api.tools.install(tool)
      setInstallJob(job)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-lg font-semibold">{title}</div>
          <div className="text-sm text-muted-foreground">
            版本检测、安装、项目启动
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            刷新
          </Button>
          {status && !status.installed ? (
            <Button type="button" onClick={() => void install()} disabled={loading}>
              安装（npm）
            </Button>
          ) : null}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      )}

      <Tabs value={tab} onValueChange={(k) => setTab(k as TabKey)}>
        <TabsList>
          {allowedTabs.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContents>
          <TabsContent value="overview">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-lg border bg-card p-4">
                {status ? (
                  <div className="space-y-2 text-sm">
                    <div>
                      安装状态：
                      {status.installed ? (
                        <span className="ml-2 text-foreground">已安装</span>
                      ) : (
                        <span className="ml-2 text-destructive">未安装</span>
                      )}
                    </div>
                    <div>版本：{status.version ?? '—'}</div>
                    <div className="break-all">
                      可执行文件：{status.executablePath ?? '—'}
                    </div>
                    <div className="break-all">
                      配置文件：{status.configPath} {status.configExists ? '' : '（不存在）'}
                    </div>

                    {!status.installed ? (
                      <div className="pt-2 text-muted-foreground">
                        未安装时仅显示首页；安装完成后会解锁“项目管理”。
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {loading ? '加载中…' : '点击刷新获取状态'}
                  </div>
                )}
              </div>

              {status?.installed ? (
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Token 统计</div>
                      <div className="text-xs text-muted-foreground">
                        汇总本机所有 {toolLabel} sessions 的 token 使用（输入 / 缓存 / 输出 / 推理）。
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadTokenUsage(true)}
                      disabled={tokenUsageLoading}
                    >
                      刷新
                    </Button>
                  </div>

                  {tokenUsage ? (
                    <TokenUsageBar usage={tokenUsage} className="mt-3" />
                  ) : (
                    <div className="mt-3 text-sm text-muted-foreground">
                      {tokenUsageLoading ? '统计中…' : '暂无数据'}
                    </div>
                  )}

                  {tokenUsageError ? (
                    <div className="mt-2 text-xs text-destructive">
                      {tokenUsageError}
                    </div>
                  ) : null}

                  <div className="mt-2 text-[11px] text-muted-foreground">
                    已启用缓存（约 2 分钟），避免重复扫描 sessions 文件。
                  </div>
                </div>
              ) : null}

              {status?.installed ? (
                <div className="rounded-lg border bg-card p-4 lg:col-span-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">最近 7 天 Token</div>
                      <div className="text-xs text-muted-foreground">
                        按天统计输入 / 缓存 / 输出 / 思考 token（本机 {toolLabel} sessions）。
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadDailyTokenUsage(true)}
                      disabled={dailyTokenUsageLoading}
                    >
                      刷新
                    </Button>
                  </div>

                  {dailyTokenUsage ? (
                    <TokenUsageDailyChart
                      days={dailyTokenUsage}
                      className="mt-3"
                    />
                  ) : (
                    <div className="mt-3 text-sm text-muted-foreground">
                      {dailyTokenUsageLoading ? '统计中…' : '暂无数据'}
                    </div>
                  )}

                  {dailyTokenUsageError ? (
                    <div className="mt-2 text-xs text-destructive">
                      {dailyTokenUsageError}
                    </div>
                  ) : null}

                  <div className="mt-2 text-[11px] text-muted-foreground">
                    已启用缓存（约 2 分钟），避免重复扫描 sessions 文件。
                  </div>
                </div>
              ) : null}
            </div>
          </TabsContent>

          {status?.installed ? (
            <TabsContent value="projects">
              <ProjectsTab toolType={toolType} />
            </TabsContent>
          ) : null}

          {status?.installed ? (
            <TabsContent value="sessions">
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">会话</div>
                    <div className="text-xs text-muted-foreground">
                      从本机 {toolLabel} sessions 扫描并按工作空间归属展示。
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void loadSessionsProjects()}
                    disabled={sessionsProjectsLoading}
                  >
                    刷新项目
                  </Button>
                </div>

                {sessionsProjectsError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                    {sessionsProjectsError}
                  </div>
                ) : null}

                <div className="rounded-lg border bg-card p-4">
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground">选择项目</div>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={sessionsProjectId ?? ''}
                      disabled={sessionsProjectsLoading || !sessionsProjects.length}
                      onChange={(e) => {
                        const next = e.target.value
                        setSessionsProjectId(next ? next : null)
                      }}
                    >
                      {!sessionsProjects.length ? (
                        <option value="">（暂无项目）</option>
                      ) : null}
                      {sessionsProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>

                    {!sessionsProjects.length ? (
                      <div className="pt-2 text-xs text-muted-foreground">
                        还没有项目：先到“项目管理”添加，或使用“自动扫描项目”从 sessions
                        生成。
                      </div>
                    ) : null}
                  </div>
                </div>

                {selectedSessionsProject ? (
                  <ProjectSessionsView
                    key={selectedSessionsProject.id}
                    project={selectedSessionsProject}
                    onBack={() => setTab('projects')}
                  />
                ) : null}
              </div>
            </TabsContent>
          ) : null}
        </TabsContents>
      </Tabs>

      {installJob ? (
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3 text-sm font-medium">
            安装日志：{installJob.kind}（{installJob.status}）
          </div>
          <pre className="max-h-[360px] overflow-auto p-4 text-xs">
            {installJob.logs.join('\n')}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
