import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'
import { Terminal as XTerm, type ITerminalOptions, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'

export type TerminalViewHandle = {
  write: (data: string) => void
  writeln: (data: string) => void
  clear: () => void
  reset: () => void
  focus: () => void
  fit: () => void
  getSize: () => { cols: number; rows: number }
}

export type TerminalViewProps = {
  className?: string
  ariaLabel?: string
  theme?: ITheme
  options?: ITerminalOptions
  onData?: (data: string) => void
  onResize?: (size: { cols: number; rows: number }) => void
}

const defaultOptions: ITerminalOptions = {
  convertEol: true,
  cursorBlink: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12,
  lineHeight: 1.25,
  scrollback: 5000,
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ className, ariaLabel, theme, options, onData, onResize }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const terminalRef = useRef<XTerm | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const resizeObserverRef = useRef<ResizeObserver | null>(null)
    const onDataRef = useRef<TerminalViewProps['onData']>(onData)
    const onResizeRef = useRef<TerminalViewProps['onResize']>(onResize)

    useEffect(() => {
      onDataRef.current = onData
    }, [onData])

    useEffect(() => {
      onResizeRef.current = onResize
    }, [onResize])

    const initialOptions = useMemo<ITerminalOptions>(() => {
      const mergedTheme = theme ?? options?.theme
      return {
        ...defaultOptions,
        ...options,
        ...(mergedTheme ? { theme: mergedTheme } : {}),
      }
    }, [options, theme])

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const terminal = new XTerm(initialOptions)
      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)

      terminal.onData((data) => onDataRef.current?.(data))
      terminal.onResize(({ cols, rows }) => onResizeRef.current?.({ cols, rows }))

      terminal.open(container)

      const fit = () => {
        try {
          fitAddon.fit()
        } catch {
          // ignore fit errors during rapid resizes/unmount
        }
      }

      // Ensure layout has settled before first fit.
      const raf = window.requestAnimationFrame(fit)

      const ro = new ResizeObserver(() => fit())
      ro.observe(container)

      terminalRef.current = terminal
      fitAddonRef.current = fitAddon
      resizeObserverRef.current = ro

      return () => {
        window.cancelAnimationFrame(raf)
        try {
          ro.disconnect()
        } catch {
          // ignore
        }
        resizeObserverRef.current = null
        fitAddonRef.current = null
        terminalRef.current = null
        try {
          terminal.dispose()
        } catch {
          // ignore
        }
      }
      // Intentionally create terminal once per mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
      const terminal = terminalRef.current
      if (!terminal) return
      if (theme) {
        terminal.options.theme = theme
      }
    }, [theme])

    useImperativeHandle(
      ref,
      () => ({
        write: (data) => terminalRef.current?.write(data),
        writeln: (data) => terminalRef.current?.writeln(data),
        clear: () => terminalRef.current?.clear(),
        reset: () => terminalRef.current?.reset(),
        focus: () => terminalRef.current?.focus(),
        fit: () => fitAddonRef.current?.fit(),
        getSize: () => ({
          cols: terminalRef.current?.cols ?? 0,
          rows: terminalRef.current?.rows ?? 0,
        }),
      }),
      [],
    )

    return (
      <div
        ref={containerRef}
        className={cn('h-full min-h-0 w-full min-w-0', className)}
        aria-label={ariaLabel}
      />
    )
  },
)
