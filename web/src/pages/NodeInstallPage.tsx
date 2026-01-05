import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import type { JobDto, ToolStatusDto } from '@/api/types'
import { Button } from '@/components/ui/button'
import { NodeInstallHeader } from '@/pages/node/NodeInstallHeader'
import { NodeInstallInstructionsCard } from '@/pages/node/NodeInstallInstructionsCard'
import { NodeInstallJobLog } from '@/pages/node/NodeInstallJobLog'
import { NodeInstallStatusCard } from '@/pages/node/NodeInstallStatusCard'

export function NodeInstallPage() {
  const navigate = useNavigate()

  const [status, setStatus] = useState<ToolStatusDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installJob, setInstallJob] = useState<JobDto | null>(null)

  const goBack = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate('/code')
  }, [navigate])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Reuse Codex status endpoint because it already reports Node/npm + platform.
      const data = await api.tools.status('codex')
      setStatus(data)
    } catch (e) {
      setError((e as Error).message)
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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

  const installLabel = useMemo(() => {
    const platform = status?.platform ?? 'unknown'
    if (platform === 'windows') return '安装 Node.js（winget）'
    if (platform === 'macos') return '安装 Node.js（Homebrew）'
    if (platform === 'linux') return '安装 Node.js（系统包管理器）'
    return '安装 Node.js'
  }, [status?.platform])

  const installDisabled = useMemo(() => {
    if (!status) return true
    if (loading) return true
    if (status.nodeInstalled && status.npmInstalled) return true
    if (installJob && installJob.status !== 'Succeeded' && installJob.status !== 'Failed')
      return true
    return false
  }, [installJob, loading, status])

  const install = async () => {
    setLoading(true)
    setError(null)
    try {
      const job = await api.tools.installNode()
      setInstallJob(job)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <NodeInstallHeader
        onBack={goBack}
        actions={
          <>
            <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
              刷新
            </Button>
            {status && !(status.nodeInstalled && status.npmInstalled) ? (
              <Button type="button" onClick={() => void install()} disabled={installDisabled}>
                {installLabel}
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          {status ? (
            <NodeInstallStatusCard status={status} />
          ) : (
            <div className="text-sm text-muted-foreground">
              {loading ? '加载中…' : '点击刷新获取状态'}
            </div>
          )}
        </div>

        <NodeInstallInstructionsCard platform={status?.platform ?? 'unknown'} />
      </div>

      {installJob ? <NodeInstallJobLog job={installJob} /> : null}
    </div>
  )
}

