import { useState, useEffect } from 'react'
import { Keyboard, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getShortcutsList, type ShortcutDefinition } from '@/hooks/useWorkspaceKeyboard'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * 快捷键分组
 */
interface ShortcutGroup {
  title: string
  shortcuts: Array<{ id: string; shortcut: ShortcutDefinition }>
}

/**
 * 将快捷键按功能分组
 */
function groupShortcuts(): ShortcutGroup[] {
  const allShortcuts = getShortcutsList()
  
  const groups: ShortcutGroup[] = [
    {
      title: '通用',
      shortcuts: allShortcuts.filter((s) =>
        ['quickOpen', 'toggleSidebar', 'togglePanel'].includes(s.id)
      ),
    },
    {
      title: '编辑器',
      shortcuts: allShortcuts.filter((s) =>
        ['closeTab', 'nextTab', 'prevTab'].includes(s.id)
      ),
    },
    {
      title: '视图切换',
      shortcuts: allShortcuts.filter((s) =>
        ['focusExplorer', 'focusSearch', 'focusGit'].includes(s.id)
      ),
    },
    {
      title: '终端',
      shortcuts: allShortcuts.filter((s) =>
        ['toggleTerminal', 'newTerminal'].includes(s.id)
      ),
    },
  ]

  return groups.filter((g) => g.shortcuts.length > 0)
}


/**
 * 快捷键徽章组件
 */
function ShortcutBadge({ text }: { text: string }) {
  // 分割快捷键文本（如 "Ctrl+Shift+E" -> ["Ctrl", "Shift", "E"]）
  const keys = text.split('+')

  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, index) => (
        <kbd
          key={index}
          className={cn(
            'inline-flex items-center justify-center',
            'min-w-[1.5rem] h-5 px-1.5',
            'text-[11px] font-medium',
            'bg-muted border border-border rounded',
            'text-muted-foreground'
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}

/**
 * KeyboardShortcutsHelp 组件属性
 */
export interface KeyboardShortcutsHelpProps {
  /** 自定义类名 */
  className?: string
  /** 是否显示触发按钮 */
  showTrigger?: boolean
  /** 外部控制的打开状态 */
  open?: boolean
  /** 打开状态变化回调 */
  onOpenChange?: (open: boolean) => void
}

/**
 * KeyboardShortcutsHelp - 快捷键帮助弹窗组件
 *
 * 显示所有可用的工作区快捷键，按功能分组展示。
 * 可以通过按钮触发，也可以通过外部状态控制。
 */
export function KeyboardShortcutsHelp({
  className,
  showTrigger = true,
  open,
  onOpenChange,
}: KeyboardShortcutsHelpProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const groups = groupShortcuts()

  // 支持外部控制和内部状态
  const isOpen = open ?? internalOpen
  const setIsOpen = onOpenChange ?? setInternalOpen

  // 监听 Ctrl+? 或 F1 打开帮助
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+? 或 F1 打开快捷键帮助
      if (
        (e.key === '?' && (e.ctrlKey || e.metaKey)) ||
        e.key === 'F1'
      ) {
        e.preventDefault()
        setIsOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setIsOpen])

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {showTrigger && (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', className)}
            title="快捷键帮助 (F1)"
          >
            <Keyboard className="h-4 w-4" />
            <span className="sr-only">快捷键帮助</span>
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5" />
            快捷键
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {groups.map((group) => (
            <div key={group.title}>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">
                {group.title}
              </h3>
              <div className="space-y-1">
                {group.shortcuts.map(({ id, shortcut }) => (
                  <div
                    key={id}
                    className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50"
                  >
                    <span className="text-sm">{shortcut.description}</span>
                    <ShortcutBadge text={shortcut.displayText} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="text-xs text-muted-foreground text-center pt-2 border-t">
          按 <ShortcutBadge text="F1" /> 或 <ShortcutBadge text="Ctrl+?" /> 打开此帮助
        </div>
      </DialogContent>
    </Dialog>
  )
}
