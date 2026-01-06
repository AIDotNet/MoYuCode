import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { ITerminalOptions, ITheme } from '@xterm/xterm'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import { cn } from '@/lib/utils'
import type { TerminalMuxSessionListener } from './TerminalMuxClient'
import { getTerminalMuxClient } from './TerminalMuxClient'

type TerminalSessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export type TerminalSessionHandle = {
  focus: () => void
  clear: () => void
  restart: () => void
  terminate: () => void
}

export type TerminalSessionProps = {
  id: string
  cwd: string
  shell?: string
  apiBase?: string
  className?: string
  ariaLabel?: string
  theme?: ITheme
  options?: ITerminalOptions
  autoFocus?: boolean
  onStatusChange?: (status: TerminalSessionStatus, error?: string) => void
}

export const TerminalSession = forwardRef<TerminalSessionHandle, TerminalSessionProps>(
  function TerminalSession(
    { id, cwd, shell, apiBase, className, ariaLabel, theme, options, autoFocus, onStatusChange },
    ref,
  ) {
    const terminalRef = useRef<TerminalViewHandle | null>(null)
    const encoderRef = useRef<TextEncoder>(new TextEncoder())
    const decoderRef = useRef<TextDecoder>(new TextDecoder())
    const autoFocusRef = useRef<boolean>(Boolean(autoFocus))
    const onStatusChangeRef = useRef<TerminalSessionProps['onStatusChange']>(onStatusChange)
    const restartRequestedRef = useRef(false)
    const [restartNonce, setRestartNonce] = useState(0)

    const mux = useMemo(() => getTerminalMuxClient(apiBase), [apiBase])

    useEffect(() => {
      autoFocusRef.current = Boolean(autoFocus)
    }, [autoFocus])

    useEffect(() => {
      if (typeof window === 'undefined') return
      if (!autoFocus) return
      const t = window.setTimeout(() => terminalRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }, [autoFocus])

    useEffect(() => {
      onStatusChangeRef.current = onStatusChange
    }, [onStatusChange])

    useEffect(() => {
      const sessionId = id.trim()
      const normalizedCwd = cwd.trim()
      const normalizedShell = shell?.trim() ? shell.trim() : undefined

      if (!sessionId) {
        onStatusChangeRef.current?.('error', 'Missing session id')
        return
      }

      if (!normalizedCwd) {
        onStatusChangeRef.current?.('error', 'Missing cwd')
        return
      }

      // Reset decoder state so multi-byte sequences don't bleed across restarts.
      decoderRef.current = new TextDecoder()

      terminalRef.current?.reset()
      onStatusChangeRef.current?.('connecting')

      let disposed = false

      const listener: TerminalMuxSessionListener = {
        onBinary: (bytes) => {
          if (disposed) return
          const handle = terminalRef.current
          if (!handle) return
          const text = decoderRef.current.decode(bytes, { stream: true })
          if (text) handle.write(text)
        },
        onExit: (exitCode) => {
          if (disposed) return
          const handle = terminalRef.current
          if (!handle) return
          const code = exitCode === null ? '' : exitCode.toString()
          handle.writeln(`\r\n[process exited ${code}]`)
          onStatusChangeRef.current?.('closed')
        },
        onError: (message) => {
          if (disposed) return
          const handle = terminalRef.current
          handle?.writeln(`\r\n[error] ${message}`)
          onStatusChangeRef.current?.('error', message)
        },
        onConnectionStatus: (status, error) => {
          if (disposed) return
          if (status === 'error') {
            onStatusChangeRef.current?.('error', error ?? 'WebSocket error')
          } else if (status === 'closed') {
            onStatusChangeRef.current?.('closed')
          }
        },
      }

      mux.register(sessionId, listener)

      void (async () => {
        try {
          const { cols, rows } = terminalRef.current?.getSize() ?? { cols: 80, rows: 24 }
          const normalizedCols = cols > 0 ? cols : 80
          const normalizedRows = rows > 0 ? rows : 24

          await mux.openSession({
            type: 'open',
            id: sessionId,
            cwd: normalizedCwd,
            shell: normalizedShell,
            cols: normalizedCols,
            rows: normalizedRows,
          })

          if (disposed) return
          onStatusChangeRef.current?.('connected')
          if (autoFocusRef.current) {
            window.setTimeout(() => terminalRef.current?.focus(), 0)
          }
        } catch (e) {
          if (disposed) return
          onStatusChangeRef.current?.('error', (e as Error).message)
        }
      })()

      return () => {
        disposed = true
        const shouldClose = restartRequestedRef.current
        restartRequestedRef.current = false
        if (shouldClose) {
          mux.closeSession(sessionId)
        } else {
          mux.detachSession(sessionId)
        }
        mux.unregister(sessionId)
      }
    }, [cwd, id, mux, restartNonce, shell])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => terminalRef.current?.focus(),
        clear: () => terminalRef.current?.clear(),
        restart: () => {
          restartRequestedRef.current = true
          setRestartNonce((n) => n + 1)
        },
        terminate: () => mux.closeSession(id.trim()),
      }),
      [id, mux],
    )

    return (
      <TerminalView
        ref={(h) => {
          terminalRef.current = h
        }}
        className={cn('h-full', className)}
        ariaLabel={ariaLabel}
        theme={theme}
        options={options}
        onData={(data) => {
          const bytes = encoderRef.current.encode(data)
          mux.sendInput(id.trim(), bytes)
        }}
        onResize={({ cols, rows }) => {
          if (!cols || !rows) return
          mux.resize(id.trim(), cols, rows)
        }}
      />
    )
  },
)
