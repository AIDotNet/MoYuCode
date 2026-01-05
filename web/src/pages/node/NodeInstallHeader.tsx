import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'

export function NodeInstallHeader({
  onBack,
  actions,
}: {
  onBack: () => void
  actions?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          返回
        </Button>
        <div>
          <div className="text-lg font-semibold">Node.js</div>
          <div className="text-sm text-muted-foreground">版本检测、安装</div>
        </div>
      </div>

      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  )
}

