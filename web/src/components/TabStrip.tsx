import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TabStripItemBase = {
  key: string
  label: string
  title?: string
  iconUrl?: string | null
  icon?: ReactNode
  dirty?: boolean
  disabled?: boolean
  closable?: boolean
  closeTitle?: string
}

export function TabStrip<T extends TabStripItemBase>({
  items,
  activeKey,
  onActivate,
  onClose,
  ariaLabel = 'Tabs',
  className,
}: {
  items: T[]
  activeKey: string | null
  onActivate: (item: T) => void
  onClose?: (item: T) => void
  ariaLabel?: string
  className?: string
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const [showLeftFade, setShowLeftFade] = useState(false)
  const [showRightFade, setShowRightFade] = useState(false)

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
    setShowLeftFade(el.scrollLeft > 0)
    setShowRightFade(el.scrollLeft < maxScrollLeft - 1)
  }, [])

  useEffect(() => {
    updateScrollFades()
  }, [items.length, updateScrollFades])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    updateScrollFades()
    el.addEventListener('scroll', updateScrollFades, { passive: true })

    const observer = new ResizeObserver(() => updateScrollFades())
    observer.observe(el)

    return () => {
      el.removeEventListener('scroll', updateScrollFades)
      observer.disconnect()
    }
  }, [updateScrollFades])

  useEffect(() => {
    if (!activeKey) return
    tabButtonRefs.current[activeKey]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])

  const focusKey = useMemo(() => {
    const hasActive = Boolean(activeKey && items.some((i) => i.key === activeKey && !i.disabled))
    if (hasActive) return activeKey
    return items.find((i) => !i.disabled)?.key ?? null
  }, [activeKey, items])

  const focusTab = useCallback((key: string) => {
    const el = tabButtonRefs.current[key]
    if (!el) return
    requestAnimationFrame(() => el.focus())
  }, [])

  const findNextEnabledIndex = useCallback(
    (fromIndex: number, direction: 1 | -1) => {
      if (items.length === 0) return null
      for (let offset = 1; offset <= items.length; offset += 1) {
        const idx = (fromIndex + direction * offset + items.length) % items.length
        const candidate = items[idx]
        if (candidate && !candidate.disabled) return idx
      }
      return null
    },
    [items],
  )

  const moveFocus = useCallback(
    (toIndex: number) => {
      const next = items[toIndex]
      if (!next) return
      onActivate(next)
      focusTab(next.key)
    },
    [focusTab, items, onActivate],
  )

  return (
    <div className={cn('relative min-w-0', className)}>
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          'flex min-w-fit items-center gap-1 overflow-x-auto pr-2',
          '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
      >
        {items.map((item, index) => {
          const active = item.key === activeKey
          const disabled = Boolean(item.disabled)
          const closable = onClose ? item.closable !== false : false

          return (
            <div
              key={item.key}
              className={cn(
                'group inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
                'max-w-[220px] shrink-0',
                'focus-within:outline-none focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-background/40 text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                disabled && 'opacity-60 pointer-events-none',
              )}
              onMouseDown={(e) => {
                if (!closable) return
                if (e.button !== 1) return
                e.preventDefault()
                onClose?.(item)
              }}
              data-active={active ? 'true' : 'false'}
            >
              <button
                ref={(el) => {
                  tabButtonRefs.current[item.key] = el
                }}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={item.key === focusKey ? 0 : -1}
                disabled={disabled}
                className={cn(
                  'min-w-0 flex flex-1 items-center gap-1 text-left outline-none',
                  'disabled:pointer-events-none disabled:opacity-50',
                )}
                onClick={() => onActivate(item)}
                onKeyDown={(e) => {
                  if (items.length === 0) return

                  if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    const nextIndex = findNextEnabledIndex(index, 1)
                    if (nextIndex !== null) moveFocus(nextIndex)
                    return
                  }

                  if (e.key === 'ArrowLeft') {
                    e.preventDefault()
                    const nextIndex = findNextEnabledIndex(index, -1)
                    if (nextIndex !== null) moveFocus(nextIndex)
                    return
                  }

                  if (e.key === 'Home') {
                    e.preventDefault()
                    const firstIndex = items.findIndex((i) => !i.disabled)
                    if (firstIndex >= 0) moveFocus(firstIndex)
                    return
                  }

                  if (e.key === 'End') {
                    e.preventDefault()
                    const lastIndex = (() => {
                      for (let i = items.length - 1; i >= 0; i -= 1) {
                        if (!items[i]?.disabled) return i
                      }
                      return -1
                    })()
                    if (lastIndex >= 0) moveFocus(lastIndex)
                    return
                  }

                  if ((e.key === 'Backspace' || e.key === 'Delete') && closable) {
                    e.preventDefault()
                    onClose?.(item)
                  }
                }}
                title={item.title ?? item.label}
              >
                {item.iconUrl ? (
                  <img
                    src={item.iconUrl}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="size-4 shrink-0"
                  />
                ) : item.icon ? (
                  <span className="shrink-0 text-muted-foreground">{item.icon}</span>
                ) : null}
                <span className="truncate">{item.label}</span>
                {item.dirty ? (
                  <span
                    className={cn(
                      'ml-1 size-1.5 shrink-0 rounded-full',
                      active ? 'bg-accent-foreground/80' : 'bg-muted-foreground',
                    )}
                    aria-label="未保存更改"
                    title="未保存更改"
                  />
                ) : null}
              </button>

              {closable ? (
                <button
                  type="button"
                  className={cn(
                    'rounded-sm p-0.5 text-muted-foreground transition-colors',
                    'hover:bg-background/60 hover:text-foreground',
                    'opacity-0 group-hover:opacity-100',
                    active ? 'opacity-100' : '',
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose?.(item)
                  }}
                  title={item.closeTitle ?? '关闭'}
                  aria-label={item.closeTitle ?? `关闭 ${item.label}`}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>

      {showLeftFade ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent"
        />
      ) : null}

      {showRightFade ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent"
        />
      ) : null}
    </div>
  )
}
