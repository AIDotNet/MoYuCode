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

const CODEX_USAGE_CACHE_KEY = 'onecode:codex:token-usage:total:v1'
const CODEX_USAGE_CACHE_TTL_MS = 2 * 60 * 1000
const CODEX_DAILY_USAGE_CACHE_KEY = 'onecode:codex:token-usage:daily:7:v1'
const CODEX_DAILY_USAGE_CACHE_TTL_MS = 2 * 60 * 1000

type CodexTokenUsageCache = {
  cachedAt: number
  data: SessionTokenUsageDto
}

function readCodexTokenUsageCache(): CodexTokenUsageCache | null {
  try {
    const raw = localStorage.getItem(CODEX_USAGE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CodexTokenUsageCache>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.cachedAt !== 'number') return null
    if (!parsed.data) return null
    return parsed as CodexTokenUsageCache
  } catch {
    return null
  }
}

function writeCodexTokenUsageCache(data: SessionTokenUsageDto) {
  try {
    const payload: CodexTokenUsageCache = { cachedAt: Date.now(), data }
    localStorage.setItem(CODEX_USAGE_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // ignore
  }
}

type CodexDailyTokenUsageCache = {
  cachedAt: number
  data: CodexDailyTokenUsageDto[]
}

function readCodexDailyTokenUsageCache(): CodexDailyTokenUsageCache | null {
  try {
    const raw = localStorage.getItem(CODEX_DAILY_USAGE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CodexDailyTokenUsageCache>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.cachedAt !== 'number') return null
    if (!Array.isArray(parsed.data)) return null
    return parsed as CodexDailyTokenUsageCache
  } catch {
    return null
  }
}

function writeCodexDailyTokenUsageCache(data: CodexDailyTokenUsageDto[]) {
  try {
    const payload: CodexDailyTokenUsageCache = { cachedAt: Date.now(), data }
    localStorage.setItem(CODEX_DAILY_USAGE_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // ignore
  }
}

export function ToolPage({ tool, title }: { tool: ToolKey; title: string }) {
  const toolType: ToolType = tool === 'codex' ? 'Codex' : 'ClaudeCode'
  const [searchParams, setSearchParams] = useSearchParams()

  const [status, setStatus] = useState<ToolStatusDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installJob, setInstallJob] = useState<JobDto | null>(null)

  const [codexTokenUsage, setCodexTokenUsage] =
    useState<SessionTokenUsageDto | null>(null)
  const [codexTokenUsageLoading, setCodexTokenUsageLoading] = useState(false)
  const [codexTokenUsageError, setCodexTokenUsageError] = useState<string | null>(
    null,
  )
  const [codexDailyTokenUsage, setCodexDailyTokenUsage] = useState<
    CodexDailyTokenUsageDto[] | null
  >(null)
  const [codexDailyTokenUsageLoading, setCodexDailyTokenUsageLoading] =
    useState(false)
  const [codexDailyTokenUsageError, setCodexDailyTokenUsageError] = useState<
    string | null
  >(null)

  const [codexProjects, setCodexProjects] = useState<ProjectDto[]>([])
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

    if (status?.installed && toolType === 'Codex') {
      tabs.push({ key: 'sessions', label: '会话' })
    }

    if (status?.installed) {
      tabs.push({ key: 'projects', label: '项目管理' })
    }

    return tabs
  }, [status?.installed, toolType])

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

  const loadCodexTokenUsage = useCallback(
    async (forceRefresh = false) => {
      if (toolType !== 'Codex') return

      setCodexTokenUsageLoading(true)
      setCodexTokenUsageError(null)
      try {
        const data = await api.tools.codexTokenUsage(forceRefresh)
        setCodexTokenUsage(data)
        writeCodexTokenUsageCache(data)
      } catch (e) {
        setCodexTokenUsageError((e as Error).message)
      } finally {
        setCodexTokenUsageLoading(false)
      }
    },
    [toolType],
  )

  const loadCodexDailyTokenUsage = useCallback(
    async (forceRefresh = false) => {
      if (toolType !== 'Codex') return

      setCodexDailyTokenUsageLoading(true)
      setCodexDailyTokenUsageError(null)
      try {
        const data = await api.tools.codexTokenUsageDaily(7, forceRefresh)
        setCodexDailyTokenUsage(data)
        writeCodexDailyTokenUsageCache(data)
      } catch (e) {
        setCodexDailyTokenUsageError((e as Error).message)
      } finally {
        setCodexDailyTokenUsageLoading(false)
      }
    },
    [toolType],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab !== 'overview') return
    if (toolType !== 'Codex') return
    if (!status?.installed) return

    const cached = readCodexTokenUsageCache()
    const now = Date.now()
    const isFresh = cached ? now - cached.cachedAt <= CODEX_USAGE_CACHE_TTL_MS : false

    if (cached?.data) {
      setCodexTokenUsage(cached.data)
    }

    if (!isFresh) {
      const t = window.setTimeout(() => {
        void loadCodexTokenUsage(false)
      }, 0)
      return () => window.clearTimeout(t)
    }
  }, [loadCodexTokenUsage, status?.installed, tab, toolType])

  useEffect(() => {
    if (tab !== 'overview') return
    if (toolType !== 'Codex') return
    if (!status?.installed) return

    const cached = readCodexDailyTokenUsageCache()
    const now = Date.now()
    const isFresh = cached
      ? now - cached.cachedAt <= CODEX_DAILY_USAGE_CACHE_TTL_MS
      : false

    if (cached?.data) {
      setCodexDailyTokenUsage(cached.data)
    }

    if (!isFresh) {
      const t = window.setTimeout(() => {
        void loadCodexDailyTokenUsage(false)
      }, 0)
      return () => window.clearTimeout(t)
    }
  }, [loadCodexDailyTokenUsage, status?.installed, tab, toolType])

  useEffect(() => {
    if (!status?.installed && (tab === 'projects' || tab === 'sessions')) {
      setTab('overview')
    }
  }, [setTab, status?.installed, tab])

  const loadCodexProjects = useCallback(async () => {
    if (toolType !== 'Codex') return
    setSessionsProjectsLoading(true)
    setSessionsProjectsError(null)
    try {
      const projects = await api.projects.list(toolType)
      setCodexProjects(projects)
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
    if (toolType !== 'Codex') return
    void loadCodexProjects()
  }, [loadCodexProjects, status?.installed, tab, toolType])

  const selectedSessionsProject = useMemo(() => {
    if (!sessionsProjectId) return null
    return codexProjects.find((p) => p.id === sessionsProjectId) ?? null
  }, [codexProjects, sessionsProjectId])

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

              {toolType === 'Codex' && status?.installed ? (
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Token 统计</div>
                      <div className="text-xs text-muted-foreground">
                        汇总本机所有 Codex sessions 的 token 使用（输入 / 缓存 / 输出 / 推理）。
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadCodexTokenUsage(true)}
                      disabled={codexTokenUsageLoading}
                    >
                      刷新
                    </Button>
                  </div>

                  {codexTokenUsage ? (
                    <TokenUsageBar usage={codexTokenUsage} className="mt-3" />
                  ) : (
                    <div className="mt-3 text-sm text-muted-foreground">
                      {codexTokenUsageLoading ? '统计中…' : '暂无数据'}
                    </div>
                  )}

                  {codexTokenUsageError ? (
                    <div className="mt-2 text-xs text-destructive">
                      {codexTokenUsageError}
                    </div>
                  ) : null}

                  <div className="mt-2 text-[11px] text-muted-foreground">
                    已启用缓存（约 2 分钟），避免重复扫描 sessions 文件。
                  </div>
                </div>
              ) : null}

              {toolType === 'Codex' && status?.installed ? (
                <div className="rounded-lg border bg-card p-4 lg:col-span-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">最近 7 天 Token</div>
                      <div className="text-xs text-muted-foreground">
                        按天统计输入 / 缓存 / 输出 / 思考 token（本机 Codex sessions）。
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadCodexDailyTokenUsage(true)}
                      disabled={codexDailyTokenUsageLoading}
                    >
                      刷新
                    </Button>
                  </div>

                  {codexDailyTokenUsage ? (
                    <TokenUsageDailyChart
                      days={codexDailyTokenUsage}
                      className="mt-3"
                    />
                  ) : (
                    <div className="mt-3 text-sm text-muted-foreground">
                      {codexDailyTokenUsageLoading ? '统计中…' : '暂无数据'}
                    </div>
                  )}

                  {codexDailyTokenUsageError ? (
                    <div className="mt-2 text-xs text-destructive">
                      {codexDailyTokenUsageError}
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

          {status?.installed && toolType === 'Codex' ? (
            <TabsContent value="sessions">
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">会话</div>
                    <div className="text-xs text-muted-foreground">
                      从本机 Codex sessions 扫描并按工作空间归属展示。
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void loadCodexProjects()}
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
                      disabled={sessionsProjectsLoading || !codexProjects.length}
                      onChange={(e) => {
                        const next = e.target.value
                        setSessionsProjectId(next ? next : null)
                      }}
                    >
                      {!codexProjects.length ? (
                        <option value="">（暂无项目）</option>
                      ) : null}
                      {codexProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>

                    {!codexProjects.length ? (
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
