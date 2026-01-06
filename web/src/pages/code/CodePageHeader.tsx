import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ChevronDown, Folder, Search } from 'lucide-react'

export function CodePageHeader({
  pickerAnchorRef,
  pickerOpen,
  pickerButtonLabel,
  onTogglePicker,
  onOpenMenu,
  sessionsAnchorRef,
  sessionsOpen,
  sessionsDisabled,
  sessionsLoading,
  sessionsCount,
  onToggleSessions,
  actionsAnchorRef,
  actionsOpen,
  onToggleActions,
  scanning,
  showScanButton,
  scanTooltip,
  onScan,
}: {
  pickerAnchorRef: RefObject<HTMLButtonElement | null>
  pickerOpen: boolean
  pickerButtonLabel: string
  onTogglePicker: () => void
  onOpenMenu: (e: ReactMouseEvent<HTMLButtonElement>) => void
  sessionsAnchorRef: RefObject<HTMLButtonElement | null>
  sessionsOpen: boolean
  sessionsDisabled: boolean
  sessionsLoading: boolean
  sessionsCount: number
  onToggleSessions: () => void
  actionsAnchorRef: RefObject<HTMLButtonElement | null>
  actionsOpen: boolean
  onToggleActions: () => void
  scanning: boolean
  showScanButton: boolean
  scanTooltip: string
  onScan: () => void
}) {
  return (
    <header className="shrink-0 flex h-8 items-center justify-between gap-3">
      <div className="min-w-0">
        <button
          ref={pickerAnchorRef}
          type="button"
          className={cn(
            'group inline-flex h-8 max-w-full items-center gap-2 rounded-md border px-2 text-left text-sm font-medium',
            'bg-background shadow-xs',
            'transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out',
            'hover:bg-accent hover:text-accent-foreground',
            'active:scale-[0.98]',
            pickerOpen && 'bg-accent text-accent-foreground shadow-sm',
          )}
          onClick={onTogglePicker}
          onContextMenu={onOpenMenu}
        >
          <Folder className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-current" />
          <span className="truncate">{pickerButtonLabel}</span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 ease-out group-hover:text-current',
              pickerOpen && 'rotate-180',
            )}
          />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          asChild
          variant="outline"
          size="sm"
          className={cn(
            'group',
            sessionsOpen && 'bg-accent text-accent-foreground shadow-sm',
          )}
        >
          <button
            ref={sessionsAnchorRef}
            type="button"
            onClick={onToggleSessions}
            aria-haspopup="menu"
            aria-expanded={sessionsOpen}
            disabled={sessionsDisabled}
            title={sessionsDisabled ? '选择项目后可查看会话' : '会话列表'}
          >
            会话{sessionsCount ? `（${sessionsCount}）` : ''}
            {sessionsLoading ? <Spinner /> : null}
            <ChevronDown
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 ease-out group-hover:text-current',
                sessionsOpen && 'rotate-180',
              )}
            />
          </button>
        </Button>
        <Button asChild variant="outline" size="sm" className="group">
          <button
            ref={actionsAnchorRef}
            type="button"
            onClick={onToggleActions}
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            title="更多功能"
          >
            更多功能
            <ChevronDown
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 ease-out group-hover:text-current',
                actionsOpen && 'rotate-180',
              )}
            />
          </button>
        </Button>
        {showScanButton ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={scanning}
            onClick={onScan}
            title={scanTooltip}
          >
            {scanning ? (
              <span className="inline-flex items-center gap-2">
                <Spinner /> 扫描中
              </span>
            ) : (
              <>
                <Search className="size-4" />
                扫描项目
              </>
            )}
          </Button>
        ) : null}
      </div>
    </header>
  )
}

