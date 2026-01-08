export type ToolKey = 'codex' | 'claude'

export type ToolType = 'Codex' | 'ClaudeCode'

export type ApiError = {
  message: string
  code: string | null
}

export type ApiResponse<T> = {
  success: boolean
  data: T
  error: ApiError | null
  traceId: string
}

export type AppVersionDto = {
  version: string
  informationalVersion: string | null
  assemblyVersion: string | null
}

export type ProviderRequestType =
  | 'AzureOpenAI'
  | 'OpenAI'
  | 'OpenAIResponses'
  | 'Anthropic'

export type JobStatus = 'Pending' | 'Running' | 'Succeeded' | 'Failed'

export type ToolStatusDto = {
  installed: boolean
  version: string | null
  executablePath: string | null
  configPath: string
  configExists: boolean
  nodeInstalled: boolean
  nodeVersion: string | null
  npmInstalled: boolean
  npmVersion: string | null
  platform: string
}

export type ToolEnvironmentDto = {
  toolType: ToolType
  environment: Record<string, string>
}

export type ToolEnvironmentUpdateRequest = {
  environment: Record<string, string>
}

export type JobDto = {
  id: string
  kind: string
  status: JobStatus
  createdAtUtc: string
  startedAtUtc: string | null
  finishedAtUtc: string | null
  exitCode: number | null
  logs: string[]
}

export type ProviderDto = {
  id: string
  name: string
  address: string
  logo: string | null
  requestType: ProviderRequestType
  azureApiVersion: string | null
  hasApiKey: boolean
  apiKeyLast4: string | null
  models: string[]
  modelsRefreshedAtUtc: string | null
}

export type ProviderUpsertRequest = {
  name: string
  address: string
  logo: string | null
  apiKey: string
  requestType: ProviderRequestType
  azureApiVersion: string | null
}

export type ProviderModelUpdateRequest = {
  model: string
}

export type ProjectDto = {
  id: string
  toolType: ToolType
  name: string
  workspacePath: string
  providerId: string | null
  providerName: string | null
  model: string | null
  lastStartedAtUtc: string | null
  createdAtUtc: string
  updatedAtUtc: string
}

export type ProjectUpsertRequest = {
  toolType: ToolType
  name: string
  workspacePath: string
  providerId: string | null
  model: string | null
}

export type ProjectEnvironmentDto = {
  projectId: string
  environment: Record<string, string>
}

export type ProjectEnvironmentUpdateRequest = {
  environment: Record<string, string>
}

export type SessionEventCountsDto = {
  message: number
  functionCall: number
  agentReasoning: number
  tokenCount: number
  other: number
}

export type SessionTokenUsageDto = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type CodexDailyTokenUsageDto = {
  date: string
  tokenUsage: SessionTokenUsageDto
}

export type SessionTimelineBucketDto = {
  message: number
  functionCall: number
  agentReasoning: number
  tokenCount: number
  other: number
}

export type SessionTraceSpanDto = {
  kind: string
  durationMs: number
  tokenCount: number
  eventCount: number
}

export type ProjectSessionDto = {
  id: string
  createdAtUtc: string
  lastEventAtUtc: string
  durationMs: number
  eventCounts: SessionEventCountsDto
  tokenUsage: SessionTokenUsageDto
  timeline: SessionTimelineBucketDto[]
  trace?: SessionTraceSpanDto[]
}

export type ProjectSessionMessageDto = {
  id: string
  role: string
  kind: string
  text: string
  timestampUtc: string
  toolName: string | null
  toolUseId: string | null
  toolInput: string | null
  toolOutput: string | null
  toolIsError: boolean
}

export type ProjectSessionMessagesPageDto = {
  messages: ProjectSessionMessageDto[]
  nextCursor: number | null
  hasMore: boolean
}

export type DriveDto = {
  name: string
  rootPath: string
  driveType: string
}

export type DirectoryEntryDto = {
  name: string
  fullPath: string
}

export type ListDirectoriesResponse = {
  currentPath: string
  parentPath: string | null
  directories: DirectoryEntryDto[]
}

export type FileEntryDto = {
  name: string
  fullPath: string
}

export type ListEntriesResponse = {
  currentPath: string
  parentPath: string | null
  directories: DirectoryEntryDto[]
  files: FileEntryDto[]
}

export type RenameEntryRequest = {
  path: string
  newName: string
}

export type RenameEntryResponse = {
  oldPath: string
  newPath: string
}

export type CreateEntryKind = 'file' | 'directory'

export type CreateEntryRequest = {
  parentPath: string
  name: string
  kind: CreateEntryKind
}

export type CreateEntryResponse = {
  fullPath: string
}

export type ReadFileResponse = {
  path: string
  content: string
  truncated: boolean
  isBinary: boolean
  sizeBytes: number
}

export type WriteFileRequest = {
  path: string
  content: string
}

export type GitStatusEntryDto = {
  path: string
  indexStatus: string
  worktreeStatus: string
  originalPath: string | null
}

export type GitStatusResponse = {
  repoRoot: string
  branch: string | null
  entries: GitStatusEntryDto[]
}

export type GitLogResponse = {
  repoRoot: string
  branch: string | null
  lines: string[]
}

export type GitBranchesResponse = {
  repoRoot: string
  current: string | null
  branches: string[]
}

export type GitCommitDiffResponse = {
  hash: string
  diff: string
  truncated: boolean
  files: string[]
}

export type GitDiffResponse = {
  file: string
  diff: string
  truncated: boolean
}

export type GitCommitRequest = {
  path: string
  message: string
}

export type GitCheckoutRequest = {
  path: string
  branch: string
}

export type GitCreateBranchRequest = {
  path: string
  branch: string
  checkout: boolean
  startPoint?: string | null
}

export type GitRepoRequest = {
  path: string
}

export type GitStageRequest = {
  path: string
  file: string
}

export type GitUnstageRequest = {
  path: string
  file: string
}

export type GitCommitResponse = {
  hash: string
  subject: string
}
