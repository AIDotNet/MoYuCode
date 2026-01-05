import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { ITerminalOptions, ITheme } from '@xterm/xterm'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import { cn } from '@/lib/utils'

type TerminalSessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export type TerminalSessionHandle = {
  focus: () => void
  clear: () => void
  restart: () => void
}

export type TerminalSessionProps = {
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

function defaultApiBase(): string {
  return (
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:5210'
  )
}

function toWebSocketUrl(apiBase: string, path: string, params: Record<string, string>): string {
  const url = new URL(apiBase)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = path
  url.search = new URLSearchParams(params).toString()
  return url.toString()
}

export const TerminalSession = forwardRef<TerminalSessionHandle, TerminalSessionProps>(
  function TerminalSession(
    { cwd, shell, apiBase, className, ariaLabel, theme, options, autoFocus, onStatusChange },
    ref,
  ) {
    const terminalRef = useRef<TerminalViewHandle | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const encoderRef = useRef<TextEncoder>(new TextEncoder())
    const decoderRef = useRef<TextDecoder>(new TextDecoder())
    const [restartNonce, setRestartNonce] = useState(0)

    const wsUrl = useMemo(() => {
      const base = (apiBase ?? defaultApiBase()).trim()
      const normalizedCwd = cwd.trim()
      const params: Record<string, string> = {
        cwd: normalizedCwd,
      }
      if (shell?.trim()) params.shell = shell.trim()
      return toWebSocketUrl(base, '/terminal/ws', params)
    }, [apiBase, cwd, shell])

    const sendResize = (cols: number, rows: number) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (!cols || !rows) return
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }

    useEffect(() => {
      const normalizedCwd = cwd.trim()
      if (!normalizedCwd) {
        onStatusChange?.('error', 'Missing cwd')
        return
      }

      terminalRef.current?.reset()
      onStatusChange?.('connecting')

      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      const reportStatus = (status: TerminalSessionStatus, err?: string) => {
        onStatusChange?.(status, err)
      }

      const reportClosed = (status: Exclude<TerminalSessionStatus, 'connected' | 'connecting'>, err?: string) => {
        if (wsRef.current === ws) wsRef.current = null
        onStatusChange?.(status, err)
      }

      ws.onopen = () => {
        reportStatus('connected')
        const { cols, rows } = terminalRef.current?.getSize() ?? { cols: 0, rows: 0 }
        sendResize(cols, rows)
        if (autoFocus) {
          window.setTimeout(() => terminalRef.current?.focus(), 0)
        }
      }

      ws.onmessage = async (event) => {
        const handle = terminalRef.current
        if (!handle) return

        if (typeof event.data === 'string') {
          try {
            const obj = JSON.parse(event.data) as { type?: unknown; exitCode?: unknown }
            if (obj?.type === 'exit') {
              const code =
                typeof obj.exitCode === 'number' ? obj.exitCode.toString() : String(obj.exitCode ?? '')
              handle.writeln(`\r\n[process exited ${code}]`)
              return
            }
          } catch {
            // ignore
          }
          return
        }

        const buf =
          event.data instanceof ArrayBuffer
            ? event.data
            : event.data instanceof Blob
              ? await event.data.arrayBuffer()
              : null

        if (!buf) return
        const text = decoderRef.current.decode(buf)
        if (text) handle.write(text)
      }

      ws.onerror = () => {
        reportClosed('error', 'WebSocket error')
      }

      ws.onclose = () => {
        reportClosed('closed')
      }

      return () => {
        if (wsRef.current === ws) wsRef.current = null
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
    }, [autoFocus, cwd, onStatusChange, restartNonce, wsUrl])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => terminalRef.current?.focus(),
        clear: () => terminalRef.current?.clear(),
        restart: () => setRestartNonce((n) => n + 1),
      }),
      [],
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
          const ws = wsRef.current
          if (!ws || ws.readyState !== WebSocket.OPEN) return
          const bytes = encoderRef.current.encode(data)
          ws.send(bytes)
        }}
        onResize={({ cols, rows }) => sendResize(cols, rows)}
      />
    )
  },
)
