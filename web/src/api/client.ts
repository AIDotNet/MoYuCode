import type {
  ApiResponse,
  AppVersionDto,
  DriveDto,
  JobDto,
  ListDirectoriesResponse,
  ListEntriesResponse,
  ProjectDto,
  ProjectSessionDto,
  ProjectSessionMessagesPageDto,
  ProjectUpsertRequest,
  CodexDailyTokenUsageDto,
  SessionTokenUsageDto,
  CreateEntryRequest,
  CreateEntryResponse,
  RenameEntryRequest,
  RenameEntryResponse,
  ProviderDto,
  ProviderModelUpdateRequest,
  ProviderUpsertRequest,
  ToolKey,
  ToolStatusDto,
  ToolEnvironmentDto,
  ToolEnvironmentUpdateRequest,
  ToolType,
  ReadFileResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitBranchesResponse,
  GitCheckoutRequest,
  GitLogResponse,
  GitCommitDiffResponse,
  GitCreateBranchRequest,
  GitRepoRequest,
  GitStageRequest,
  GitStatusResponse,
  GitUnstageRequest,
  WriteFileRequest,
  ProjectEnvironmentDto,
  ProjectEnvironmentUpdateRequest,
} from '@/api/types'

const API_BASE =''

function isApiResponse(value: unknown): value is ApiResponse<unknown> {
  if (!value || typeof value !== 'object') return false
  const v = value as { [k: string]: unknown }
  return (
    typeof v.success === 'boolean' &&
    'data' in v &&
    'error' in v &&
    typeof v.traceId === 'string'
  )
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (res.status === 204) {
    return undefined as T
  }

  const text = await res.text().catch(() => '')
  if (!text) {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return undefined as T
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`)
    return text as T
  }

  if (isApiResponse(parsed)) {
    if (parsed.success) return parsed.data as T
    const msg = parsed.error?.message || `${res.status} ${res.statusText}`
    const traceId = parsed.traceId ? ` (traceId: ${parsed.traceId})` : ''
    throw new Error(`${msg}${traceId}`)
  }

  if (!res.ok) {
    throw new Error(text || `${res.status} ${res.statusText}`)
  }

  return parsed as T
}

export const api = {
  app: {
    version: () => http<AppVersionDto>(`/api/version`),
  },
  tools: {
    status: (tool: ToolKey) => http<ToolStatusDto>(`/api/tools/${tool}/status`),
    install: (tool: ToolKey) => http<JobDto>(`/api/tools/${tool}/install`, { method: 'POST' }),
    installNode: () => http<JobDto>(`/api/tools/node/install`, { method: 'POST' }),
    environment: (tool: ToolKey) =>
      http<ToolEnvironmentDto>(`/api/tools/${tool}/environment`),
    updateEnvironment: (tool: ToolKey, body: ToolEnvironmentUpdateRequest) =>
      http<ToolEnvironmentDto>(`/api/tools/${tool}/environment`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    codexTokenUsage: (forceRefresh = false) =>
      http<SessionTokenUsageDto>(
        `/api/tools/codex/token-usage${forceRefresh ? '?forceRefresh=true' : ''}`,
      ),
    codexTokenUsageDaily: (days = 7, forceRefresh = false) => {
      const sp = new URLSearchParams()
      sp.set('days', String(days))
      if (forceRefresh) sp.set('forceRefresh', 'true')
      return http<CodexDailyTokenUsageDto[]>(
        `/api/tools/codex/token-usage/daily?${sp.toString()}`,
      )
    },
    claudeTokenUsage: (forceRefresh = false) =>
      http<SessionTokenUsageDto>(
        `/api/tools/claude/token-usage${forceRefresh ? '?forceRefresh=true' : ''}`,
      ),
    claudeTokenUsageDaily: (days = 7, forceRefresh = false) => {
      const sp = new URLSearchParams()
      sp.set('days', String(days))
      if (forceRefresh) sp.set('forceRefresh', 'true')
      return http<CodexDailyTokenUsageDto[]>(
        `/api/tools/claude/token-usage/daily?${sp.toString()}`,
      )
    },
  },
  jobs: {
    get: (id: string) => http<JobDto>(`/api/jobs/${id}`),
  },
  providers: {
    list: () => http<ProviderDto[]>(`/api/providers`),
    create: (body: ProviderUpsertRequest) =>
      http<ProviderDto>(`/api/providers`, { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: ProviderUpsertRequest) =>
      http<ProviderDto>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) => http<void>(`/api/providers/${id}`, { method: 'DELETE' }),
    refreshModels: (id: string) =>
      http<ProviderDto>(`/api/providers/${id}/refresh-models`, { method: 'POST' }),
    addModel: (id: string, body: ProviderModelUpdateRequest) =>
      http<ProviderDto>(`/api/providers/${id}/models`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    removeModel: (id: string, model: string) =>
      http<ProviderDto>(
        `/api/providers/${id}/models?model=${encodeURIComponent(model)}`,
        { method: 'DELETE' },
      ),
  },
  projects: {
    list: (toolType: ToolType) =>
      http<ProjectDto[]>(`/api/projects?toolType=${encodeURIComponent(toolType)}`),
    get: (id: string) => http<ProjectDto>(`/api/projects/${id}`),
    create: (body: ProjectUpsertRequest) =>
      http<ProjectDto>(`/api/projects`, { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: ProjectUpsertRequest) =>
      http<ProjectDto>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) => http<void>(`/api/projects/${id}`, { method: 'DELETE' }),
    start: (id: string) => http<void>(`/api/projects/${id}/start`, { method: 'POST' }),
    environment: (id: string) =>
      http<ProjectEnvironmentDto>(`/api/projects/${id}/environment`),
    updateEnvironment: (id: string, body: ProjectEnvironmentUpdateRequest) =>
      http<ProjectEnvironmentDto>(`/api/projects/${id}/environment`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    sessions: (id: string) => http<ProjectSessionDto[]>(`/api/projects/${id}/sessions`),
    sessionMessages: (
      id: string,
      sessionId: string,
      opts?: { before?: number | null; limit?: number },
    ) => {
      const sp = new URLSearchParams()
      if (opts?.before != null) sp.set('before', String(opts.before))
      if (opts?.limit != null) sp.set('limit', String(opts.limit))
      const query = sp.toString()
      const encodedSessionId = encodeURIComponent(sessionId)
      const suffix = query ? `?${query}` : ''
      return http<ProjectSessionMessagesPageDto>(
        `/api/projects/${id}/sessions/${encodedSessionId}/messages${suffix}`,
      )
    },
    scanCodexSessions: (toolType: ToolType) =>
      new EventSource(
        `${API_BASE}/api/projects/scan-codex-sessions?toolType=${encodeURIComponent(toolType)}`,
      ),
  },
  fs: {
    drives: () => http<DriveDto[]>(`/api/fs/drives`),
    listDirectories: (path: string) =>
      http<ListDirectoriesResponse>(`/api/fs/list?path=${encodeURIComponent(path)}`),
    listEntries: (path: string) =>
      http<ListEntriesResponse>(`/api/fs/entries?path=${encodeURIComponent(path)}`),
    hasGitRepo: (path: string) =>
      http<boolean>(`/api/fs/has-git?path=${encodeURIComponent(path)}`),
    readFile: (path: string, opts?: { offset?: number; limit?: number }) => {
      const sp = new URLSearchParams()
      sp.set('path', path)
      if (opts?.offset != null) sp.set('offset', String(opts.offset))
      if (opts?.limit != null) sp.set('limit', String(opts.limit))
      const suffix = sp.toString()
      return http<ReadFileResponse>(`/api/fs/file?${suffix}`)
    },
    writeFile: (body: WriteFileRequest) =>
      http<void>(`/api/fs/file`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteEntry: (path: string) =>
      http<void>(`/api/fs/entry?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
    renameEntry: (body: RenameEntryRequest) =>
      http<RenameEntryResponse>(`/api/fs/rename`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createEntry: (body: CreateEntryRequest) =>
      http<CreateEntryResponse>(`/api/fs/create`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revealInExplorer: (path: string) =>
      http<void>(`/api/fs/reveal?path=${encodeURIComponent(path)}`, { method: 'POST' }),
    openTerminal: (path: string) =>
      http<void>(`/api/fs/terminal?path=${encodeURIComponent(path)}`, { method: 'POST' }),
  },
  git: {
    status: (path: string) =>
      http<GitStatusResponse>(`/api/git/status?path=${encodeURIComponent(path)}`),
    branches: (path: string) =>
      http<GitBranchesResponse>(`/api/git/branches?path=${encodeURIComponent(path)}`),
    createBranch: (body: GitCreateBranchRequest) =>
      http<string>(`/api/git/branches`, { method: 'POST', body: JSON.stringify(body) }),
    log: (path: string, maxCount = 200) =>
      http<GitLogResponse>(
        `/api/git/log?path=${encodeURIComponent(path)}&maxCount=${encodeURIComponent(String(maxCount))}`,
      ),
    commitDiff: (path: string, hash: string) =>
      http<GitCommitDiffResponse>(
        `/api/git/commit-diff?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`,
      ),
    diff: (path: string, file: string, opts?: { staged?: boolean }) => {
      const staged = opts?.staged ? '&staged=true' : ''
      return http<GitDiffResponse>(
        `/api/git/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}${staged}`,
      )
    },
    stage: (body: GitStageRequest) =>
      http<void>(`/api/git/stage`, { method: 'POST', body: JSON.stringify(body) }),
    unstage: (body: GitUnstageRequest) =>
      http<void>(`/api/git/unstage`, { method: 'POST', body: JSON.stringify(body) }),
    commit: (body: GitCommitRequest) =>
      http<GitCommitResponse>(`/api/git/commit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    checkout: (body: GitCheckoutRequest) =>
      http<string>(`/api/git/checkout`, { method: 'POST', body: JSON.stringify(body) }),
    pull: (body: GitRepoRequest) =>
      http<string>(`/api/git/pull`, { method: 'POST', body: JSON.stringify(body) }),
    push: (body: GitRepoRequest) =>
      http<string>(`/api/git/push`, { method: 'POST', body: JSON.stringify(body) }),
  },
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
