import type { JobDto } from '@/api/types'

export function NodeInstallJobLog({ job }: { job: JobDto }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3 text-sm font-medium">
        安装日志：{job.kind}（{job.status}）
      </div>
      <pre className="max-h-[360px] overflow-auto p-4 text-xs">
        {job.logs.join('\n')}
      </pre>
    </div>
  )
}

