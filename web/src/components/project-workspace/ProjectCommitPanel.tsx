import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/api/client'
import type { GitLogResponse, GitStatusEntryDto, GitStatusResponse } from '@/api/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { GitCommit, RefreshCw } from 'lucide-react'
import { GitGraph } from './GitGraph'

function getEntryLabel(entry: GitStatusEntryDto): string {
  const index = entry.indexStatus
  const wt = entry.worktreeStatus

  if (index === '?' && wt === '?') return 'U'
  if (index === 'A' || wt === 'A') return 'A'
  if (index === 'D' || wt === 'D') return 'D'
  if (index === 'R' || wt === 'R') return 'R'
  if (index === 'C' || wt === 'C') return 'C'
  if (index === 'M' || wt === 'M') return 'M'
  return `${index}${wt}`.trim() || '·'
}

function getEntryBadgeClass(entry: GitStatusEntryDto): string {
  const label = getEntryLabel(entry)
  switch (label) {
    case 'M':
      return 'bg-sky-500/15 text-sky-300 ring-sky-500/30'
    case 'A':
      return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
    case 'D':
      return 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
    case 'R':
    case 'C':
      return 'bg-amber-500/15 text-amber-200 ring-amber-500/30'
    case 'U':
      return 'bg-muted/40 text-muted-foreground ring-border/60'
    default:
      return 'bg-muted/40 text-muted-foreground ring-border/60'
  }
}

function getEntryTitle(entry: GitStatusEntryDto): string {
  const parts = [
    entry.indexStatus ? `index:${entry.indexStatus}` : null,
    entry.worktreeStatus ? `worktree:${entry.worktreeStatus}` : null,
  ].filter(Boolean)
  return parts.join(' ')
}

export function ProjectCommitPanel({
  workspacePath,
  onOpenDiff,
}: {
  workspacePath: string
  onOpenDiff?: (file: string) => void
}) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [log, setLog] = useState<GitLogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [message, setMessage] = useState('')
  const [commitBusy, setCommitBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const path = workspacePath.trim()
    if (!path) return

    setLoading(true)
    setLoadError(null)
    try {
      const [s, l] = await Promise.all([api.git.status(path), api.git.log(path, 200)])
      setStatus(s)
      setLog(l)
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const entries = status?.entries ?? []
  const repoRoot = status?.repoRoot ?? log?.repoRoot ?? ''
  const branch = status?.branch ?? log?.branch ?? null

  const hasChanges = entries.length > 0

  const commit = useCallback(async () => {
    const path = workspacePath.trim()
    const msg = message.trim()
    if (!path || !msg || commitBusy) return

    setCommitBusy(true)
    setCommitError(null)
    try {
      await api.git.commit({ path, message: msg })
      setMessage('')
      await refresh()
    } catch (e) {
      setCommitError((e as Error).message)
    } finally {
      setCommitBusy(false)
    }
  }, [commitBusy, message, refresh, workspacePath])

  const logLines = useMemo(() => log?.lines ?? [], [log?.lines])

  return (
    <div className="h-full min-h-0 overflow-hidden flex flex-col">
      <div className="p-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[11px] text-muted-foreground" title={repoRoot}>
              {branch ? ` ${branch}` : ' (detached)'}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="刷新"
            onClick={() => void refresh()}
            disabled={loading || commitBusy}
          >
            <RefreshCw className={cn('size-4', loading ? 'motion-safe:animate-spin' : '')} />
          </Button>
        </div>

        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          disabled={commitBusy || loading}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void commit()
            }
          }}
        />

        <Button
          type="button"
          className="w-full"
          disabled={!hasChanges || commitBusy || loading || !message.trim()}
          onClick={() => void commit()}
        >
          {commitBusy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner /> Commit…
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <GitCommit className="size-4" />
              Commit
            </span>
          )}
        </Button>

        {commitError ? <div className="text-xs text-destructive">{commitError}</div> : null}
        {loadError ? <div className="text-xs text-destructive">{loadError}</div> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden flex flex-col border-t">
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {loading ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Spinner /> 加载中…
              </span>
            </div>
          ) : entries.length ? (
            <div className="space-y-1">
              {entries.map((entry) => {
                const label = getEntryLabel(entry)
                const fileLabel = entry.originalPath
                  ? `${entry.originalPath} → ${entry.path}`
                  : entry.path
                return (
                  <button
                    key={`${entry.indexStatus}${entry.worktreeStatus}:${entry.path}`}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                      'transition-colors hover:bg-accent/40',
                    )}
                    onClick={() => onOpenDiff?.(entry.path)}
                    title={getEntryTitle(entry)}
                  >
                    <span
                      className={cn(
                        'inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold',
                        'ring-1 ring-inset',
                        getEntryBadgeClass(entry),
                      )}
                    >
                      {label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs">{fileLabel}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="px-2 py-4 text-xs text-muted-foreground">No uncommitted changes</div>
          )}
        </div>

        <div className="shrink-0 border-t px-2 py-2 max-h-[45%] overflow-auto">
          <GitGraph lines={logLines} />
        </div>
      </div>
    </div>
  )
}
