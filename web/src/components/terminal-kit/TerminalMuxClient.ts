type TerminalMuxConnectionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export type TerminalMuxSessionListener = {
  onBinary?: (data: Uint8Array) => void
  onExit?: (exitCode: number | null) => void
  onError?: (message: string) => void
  onConnectionStatus?: (status: TerminalMuxConnectionStatus, error?: string) => void
}

type OpenSessionMessage = {
  type: 'open'
  id: string
  cwd: string
  shell?: string
  cols: number
  rows: number
}

type ResizeMessage = {
  type: 'resize'
  id: string
  cols: number
  rows: number
}

type CloseMessage = {
  type: 'close'
  id: string
}

type DetachMessage = {
  type: 'detach'
  id: string
}

type ClientMessage = OpenSessionMessage | ResizeMessage | DetachMessage | CloseMessage

type ExitMessage = {
  type?: unknown
  id?: unknown
  exitCode?: unknown
}

type ErrorMessage = {
  type?: unknown
  id?: unknown
  message?: unknown
}

const SESSION_ID_LENGTH = 36
const HEADER_LENGTH = SESSION_ID_LENGTH + 1 // "<uuid>\n"
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

const headerCache = new Map<string, Uint8Array>()

function defaultApiBase(): string {
  return ('')
}

function toWebSocketUrl(apiBase: string, path: string): string {
  // 如果 apiBase 为空或相对路径（开发环境通过 Vite 代理）
  // 则使用当前页面协议和主机，将协议转换为 ws/wss
  if (!apiBase || apiBase.startsWith('/')) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    return `${protocol}//${host}${path}`
  }

  // 生产环境或明确指定了 apiBase
  const url = new URL(apiBase)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = path
  url.search = ''
  return url.toString()
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseExitMessage(raw: unknown): { id: string; exitCode: number | null } | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as ExitMessage
  if (v.type !== 'exit') return null
  if (!isNonEmptyString(v.id)) return null
  const exitCode = typeof v.exitCode === 'number' ? v.exitCode : null
  return { id: v.id.trim(), exitCode }
}

function parseErrorMessage(raw: unknown): { id: string | null; message: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as ErrorMessage
  if (v.type !== 'error') return null
  const id = isNonEmptyString(v.id) ? v.id.trim() : null
  const message = isNonEmptyString(v.message) ? v.message.trim() : 'Terminal error'
  return { id, message }
}

function getHeaderBytes(id: string): Uint8Array | null {
  const normalizedId = id.trim()
  if (normalizedId.length !== SESSION_ID_LENGTH) return null

  const cached = headerCache.get(normalizedId)
  if (cached) return cached

  // Header is ASCII-friendly; enforce fixed length so parsing is trivial.
  const headerText = `${normalizedId}\n`
  const headerBytes = utf8Encoder.encode(headerText)
  if (headerBytes.length !== HEADER_LENGTH) return null

  headerCache.set(normalizedId, headerBytes)
  return headerBytes
}

function buildBinaryFrame(id: string, payload: Uint8Array): Uint8Array | null {
  const headerBytes = getHeaderBytes(id)
  if (!headerBytes) return null

  const buf = new Uint8Array(headerBytes.length + payload.length)
  buf.set(headerBytes, 0)
  buf.set(payload, headerBytes.length)
  return buf
}

function tryParseBinaryFrame(bytes: Uint8Array): { id: string; payload: Uint8Array } | null {
  if (bytes.length < HEADER_LENGTH) return null
  if (bytes[SESSION_ID_LENGTH] !== 10) return null // '\n'

  const id = utf8Decoder.decode(bytes.subarray(0, SESSION_ID_LENGTH)).trim()
  if (id.length !== SESSION_ID_LENGTH) return null

  return { id, payload: bytes.subarray(HEADER_LENGTH) }
}

export class TerminalMuxClient {
  private readonly wsUrl: string
  private readonly listeners = new Map<string, TerminalMuxSessionListener>()

  private ws: WebSocket | null = null
  private connectPromise: Promise<void> | null = null

  constructor(apiBase: string) {
    this.wsUrl = toWebSocketUrl(apiBase, '/api/terminal/mux')
  }

  register(id: string, listener: TerminalMuxSessionListener) {
    this.listeners.set(id, listener)
  }

  unregister(id: string) {
    this.listeners.delete(id)
    if (this.listeners.size === 0) {
      this.closeConnection()
    }
  }

  async openSession(message: OpenSessionMessage) {
    await this.connect()
    this.sendJson(message)
  }

  resize(id: string, cols: number, rows: number) {
    this.sendJson({ type: 'resize', id, cols, rows })
  }

  closeSession(id: string) {
    this.sendJson({ type: 'close', id })
  }

  detachSession(id: string) {
    this.sendJson({ type: 'detach', id })
  }

  sendInput(id: string, payload: Uint8Array) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const frame = buildBinaryFrame(id, payload)
    if (!frame) return
    ws.send(frame)
  }

  private notifyConnectionStatus(status: TerminalMuxConnectionStatus, error?: string) {
    for (const listener of this.listeners.values()) {
      listener.onConnectionStatus?.(status, error)
    }
  }

  private closeConnection() {
    const ws = this.ws
    this.ws = null
    this.connectPromise = null
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
    this.notifyConnectionStatus('closed')
  }

  async connect(): Promise<void> {
    const existing = this.ws
    if (existing && existing.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise

    this.notifyConnectionStatus('connecting')

    const ws = new WebSocket(this.wsUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false

      const fail = (msg: string) => {
        if (settled) return
        settled = true
        this.ws = null
        this.connectPromise = null
        this.notifyConnectionStatus('error', msg)
        reject(new Error(msg))
      }

      ws.onopen = () => {
        if (settled) return
        settled = true
        this.notifyConnectionStatus('connected')
        resolve()
      }

      ws.onerror = () => {
        fail('WebSocket error')
      }

      ws.onclose = () => {
        this.ws = null
        this.connectPromise = null
        if (!settled) {
          settled = true
          this.notifyConnectionStatus('closed')
          reject(new Error('WebSocket closed'))
          return
        }
        this.notifyConnectionStatus('closed')
      }

      ws.onmessage = (event) => {
        void this.handleMessage(event.data)
      }
    })

    return this.connectPromise
  }

  private sendJson(message: ClientMessage) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // ignore
    }
  }

  private async handleMessage(data: unknown) {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as unknown
        const exit = parseExitMessage(parsed)
        if (exit) {
          this.listeners.get(exit.id)?.onExit?.(exit.exitCode)
          return
        }

        const err = parseErrorMessage(parsed)
        if (err) {
          if (err.id) {
            this.listeners.get(err.id)?.onError?.(err.message)
          } else {
            for (const listener of this.listeners.values()) {
              listener.onError?.(err.message)
            }
          }
        }
      } catch {
        // ignore
      }
      return
    }

    const buf =
      data instanceof ArrayBuffer
        ? data
        : data instanceof Blob
          ? await data.arrayBuffer()
          : null
    if (!buf) return

    const bytes = new Uint8Array(buf)
    const parsed = tryParseBinaryFrame(bytes)
    if (!parsed) return

    this.listeners.get(parsed.id)?.onBinary?.(parsed.payload)
  }
}

const muxByBase = new Map<string, TerminalMuxClient>()

export function getTerminalMuxClient(apiBase?: string): TerminalMuxClient {
  const base = (apiBase ?? defaultApiBase()).trim()
  const existing = muxByBase.get(base)
  if (existing) return existing
  const created = new TerminalMuxClient(base)
  muxByBase.set(base, created)
  return created
}
