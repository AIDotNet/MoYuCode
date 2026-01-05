import type {
  ApiResponse,
  DriveDto,
  JobDto,
  ListDirectoriesResponse,
  ListEntriesResponse,
  ProjectDto,
  ProjectSessionDto,
  ProjectUpsertRequest,
  CodexDailyTokenUsageDto,
  SessionTokenUsageDto,
  CreateEntryRequest,
  CreateEntryResponse,
  RenameEntryRequest,
  RenameEntryResponse,
  ProviderDto,
  ProviderUpsertRequest,
  ToolKey,
  ToolStatusDto,
  ToolType,
  ReadFileResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitLogResponse,
  GitStatusResponse,
  WriteFileRequest,
} from '@/api/types'

const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  'http://localhost:5210'

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
  tools: {
    status: (tool: ToolKey) => http<ToolStatusDto>(`/api/tools/${tool}/status`),
    install: (tool: ToolKey) => http<JobDto>(`/api/tools/${tool}/install`, { method: 'POST' }),
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
    sessions: (id: string) => http<ProjectSessionDto[]>(`/api/projects/${id}/sessions`),
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
    readFile: (path: string) =>
      http<ReadFileResponse>(`/api/fs/file?path=${encodeURIComponent(path)}`),
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
    log: (path: string, maxCount = 200) =>
      http<GitLogResponse>(
        `/api/git/log?path=${encodeURIComponent(path)}&maxCount=${encodeURIComponent(String(maxCount))}`,
      ),
    diff: (path: string, file: string) =>
      http<GitDiffResponse>(
        `/api/git/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`,
      ),
    commit: (body: GitCommitRequest) =>
      http<GitCommitResponse>(`/api/git/commit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
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
