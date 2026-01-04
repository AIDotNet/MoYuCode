import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { PanelLeftClose } from 'lucide-react'

export type ProjectFileManagerTabKey = 'files' | 'commit'

export function ProjectFileManagerPanel({
  className,
  notice,
  hasGit,
  activeTab,
  onTabChange,
  onRequestClose,
  filesView,
  commitView,
}: {
  className?: string
  notice?: string | null
  hasGit: boolean
  activeTab: ProjectFileManagerTabKey
  onTabChange: (tab: ProjectFileManagerTabKey) => void
  onRequestClose: () => void
  filesView: ReactNode
  commitView: ReactNode
}) {
  return (
    <div className={cn('h-full min-h-0 overflow-hidden flex flex-col', className)}>
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="收起文件管理"
          onClick={onRequestClose}
        >
          <PanelLeftClose className="size-4" />
        </Button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cn(
              'rounded-md px-2 py-1 text-xs font-medium transition-colors',
              activeTab === 'files'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
            onClick={() => onTabChange('files')}
          >
            Files
          </button>
          {hasGit ? (
            <button
              type="button"
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                activeTab === 'commit'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
              onClick={() => onTabChange('commit')}
            >
              Commit
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="p-2">
          <Alert className="py-2">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'commit' ? commitView : filesView}
      </div>
    </div>
  )
}

