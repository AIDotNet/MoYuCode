import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, formatUtc } from '@/api/client'
import type { ProviderDto, ProviderRequestType, ProviderUpsertRequest } from '@/api/types'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/Modal'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
} from 'lucide-react'

type ProviderPreset = {
  id: string
  name: string
  icon: string
  baseUrl: string
  homepage?: string
  description?: string
}

type SelectedProviderRef =
  | { kind: 'preset'; id: string }
  | { kind: 'custom'; id: string }

type ProviderListItem = {
  key: string
  kind: SelectedProviderRef['kind']
  name: string
  icon: string
  baseUrl: string
  configured: boolean
  sortIndex: number
  preset?: ProviderPreset
  provider?: ProviderDto
}

function presetKey(id: string): string {
  return `preset:${id}`
}

function customKey(id: string): string {
  return `custom:${id}`
}

function parseSelectedKey(key: string): SelectedProviderRef | null {
  if (key.startsWith('preset:')) return { kind: 'preset', id: key.slice(7) }
  if (key.startsWith('custom:')) return { kind: 'custom', id: key.slice(7) }
  return null
}

function MaskIcon({ src, className }: { src: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('bg-current', className)}
      style={{
        maskImage: `url(${src})`,
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
      }}
    />
  )
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function joinUrl(baseUrl: string, path: string): string {
  const base = trimTrailingSlash(baseUrl)
  if (!path) return base
  if (path.startsWith('/')) return `${base}${path}`
  return `${base}/${path}`
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function requestTypeLabel(value: ProviderRequestType): string {
  switch (value) {
    case 'OpenAI':
      return 'OpenAI Chat'
    case 'OpenAIResponses':
      return 'OpenAI Responses'
    case 'AzureOpenAI':
      return 'Azure OpenAI'
    case 'Anthropic':
      return 'Anthropic'
  }
}

const customProviderFallbackIcon = '/icon/code.svg'

function ProviderLogo({ src, className }: { src: string; className?: string }) {
  const trimmed = (src ?? '').trim()
  const actual = trimmed || customProviderFallbackIcon
  const useMask = actual.startsWith('/icon/') && actual.toLowerCase().endsWith('.svg')

  if (useMask) {
    return <MaskIcon src={actual} className={className} />
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      src={actual}
      className={cn('object-contain', className)}
    />
  )
}

function iconLabel(src: string): string {
  const trimmed = (src ?? '').trim()
  if (!trimmed) return '（未设置）'
  if (trimmed.startsWith('data:')) return '已上传'

  const base = trimmed.split('?')[0]?.split('#')[0] ?? trimmed
  const file = base.split('/').pop() ?? base
  return file.replace(/\.(svg|png|jpg|jpeg|webp)$/i, '') || file
}

const providerPresets: ProviderPreset[] = [
  {
    id: 'routin',
    name: 'Routin',
    icon: '/icon/routin.ico',
    baseUrl: 'https://api.routin.ai/v1',
    homepage: 'https://routin.ai/dashboard/api-keys',
    description: 'AI 助手平台，提供智能对话和代码生成服务，最低 0.2￥=1美刀可以使用Codex。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '/icon/openai.svg',
    baseUrl: 'https://api.openai.com/v1',
    homepage: 'https://platform.openai.com',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    icon: '/icon/gemini.svg',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    homepage: 'https://ai.google.dev/gemini-api/docs/openai?hl=zh-cn',
    description: 'Google Gemini（OpenAI 兼容端点）',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    icon: '/icon/xai.svg',
    baseUrl: 'https://api.x.ai/v1',
    homepage: 'https://docs.x.ai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '/icon/deepseek.svg',
    baseUrl: 'https://api.deepseek.com/v1',
    homepage: 'https://platform.deepseek.com',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    icon: '/icon/moonshot.svg',
    baseUrl: 'https://api.moonshot.cn/v1',
    homepage: 'https://platform.moonshot.cn',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    icon: '/icon/minimax.svg',
    baseUrl: 'https://api.minimax.chat/v1',
    homepage: 'https://www.minimax.chat',
  },
  {
    id: 'qwen',
    name: 'Qwen (DashScope)',
    icon: '/icon/qwen.svg',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    homepage: 'https://dashscope.console.aliyun.com',
    description: '阿里云 DashScope（OpenAI 兼容模式）',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    icon: '/icon/hunyuan.svg',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    homepage: 'https://cloud.tencent.com/product/hunyuan',
  },
  {
    id: 'spark',
    name: '讯飞星火',
    icon: '/icon/spark.svg',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    homepage: 'https://www.xfyun.cn',
  },
  {
    id: 'yi',
    name: 'Yi (零一万物)',
    icon: '/icon/yi.svg',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    homepage: 'https://platform.lingyiwanwu.com',
  },
  {
    id: 'zai',
    name: 'Z.ai',
    icon: '/icon/zai.svg',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    homepage: 'https://docs.z.ai',
  },
  {
    id: 'zhipu',
    name: '智谱 AI (BigModel)',
    icon: '/icon/zhipu.svg',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    homepage: 'https://open.bigmodel.cn',
    description: '注意：BigModel 使用 /v4 版本路径',
  },
  {
    id: 'doubao',
    name: '豆包 (火山方舟)',
    icon: '/icon/doubao.svg',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    homepage: 'https://www.volcengine.com/product/ark',
    description: '注意：方舟使用 /v3 版本路径',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '/icon/openrouter.svg',
    baseUrl: 'https://openrouter.ai/api/v1',
    homepage: 'https://openrouter.ai',
  },
  {
    id: 'ai302',
    name: '302.AI',
    icon: '/icon/ai302.svg',
    baseUrl: 'https://api.302.ai/v1',
    homepage: 'https://302.ai',
  },
  {
    id: 'ppio',
    name: 'PPIO',
    icon: '/icon/ppio.svg',
    baseUrl: 'https://api.ppinfra.com/v3/openai',
    homepage: 'https://ppio.com',
    description: '注意：PPIO 使用 /v3/openai 路径',
  },
  {
    id: 'qiniu',
    name: '七牛云 AI',
    icon: '/icon/qiniu.svg',
    baseUrl: 'https://api.qnaigc.com/v1',
    homepage: 'https://developer.qiniu.com',
  },
  {
    id: 'poe',
    name: 'Poe',
    icon: '/icon/poe.svg',
    baseUrl: 'https://api.poe.com/v1',
    homepage: 'https://poe.com',
  },
  {
    id: 'newapi',
    name: 'New API',
    icon: '/icon/newapi.svg',
    baseUrl: 'http://localhost:3000/v1',
    homepage: 'https://github.com/QuantumNous/new-api',
    description: '默认本地地址，可按需自行部署',
  },
  {
    id: 'openwebui',
    name: 'Open WebUI',
    icon: '/icon/openwebui.svg',
    baseUrl: 'http://localhost:3000/api/v1',
    homepage: 'https://openwebui.com',
    description: '默认本地地址：OpenAI 兼容 API',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '/icon/ollama.svg',
    baseUrl: 'http://localhost:11434/v1',
    homepage: 'https://ollama.com',
  },
]

const presetBaseUrlSet = new Set(
  providerPresets.map((p) => trimTrailingSlash(p.baseUrl)),
)

const providerIconOptions = Array.from(
  new Set([customProviderFallbackIcon, ...providerPresets.map((p) => p.icon)]),
).sort((a, b) => a.localeCompare(b, 'en'))

function IconPickerModal({
  open,
  value,
  onClose,
  onSelect,
}: {
  open: boolean
  value: string
  onClose: () => void
  onSelect: (next: string) => void
}) {
  if (!open) return null

  return <IconPickerModalBody value={value} onClose={onClose} onSelect={onSelect} />
}

function IconPickerModalBody({
  value,
  onClose,
  onSelect,
}: {
  value: string
  onClose: () => void
  onSelect: (next: string) => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState(value ?? '')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const filteredIcons = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return providerIconOptions
    return providerIconOptions.filter((src) =>
      iconLabel(src).toLowerCase().includes(q),
    )
  }, [query])

  const pick = useCallback(
    (next: string) => {
      onSelect(next)
      onClose()
    },
    [onClose, onSelect],
  )

  const upload = useCallback(
    (file: File) => {
      setUploadError(null)
      const maxBytes = 256 * 1024
      if (file.size > maxBytes) {
        setUploadError('文件过大：请使用 ≤ 256KB 的图标（建议 SVG）。')
        return
      }

      const reader = new FileReader()
      reader.onerror = () => {
        setUploadError('读取文件失败，请重试。')
      }
      reader.onload = () => {
        const result = String(reader.result ?? '')
        if (!result.startsWith('data:image/')) {
          setUploadError('不支持的文件类型：请上传图片（SVG/PNG/JPG/WebP）。')
          return
        }
        pick(result)
      }
      reader.readAsDataURL(file)
    },
    [pick],
  )

  return (
    <Modal open title="选择/上传图标" onClose={onClose} className="max-w-3xl">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-md border bg-background text-foreground">
              <ProviderLogo src={draft} className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium">当前图标</div>
              <div className="truncate text-xs text-muted-foreground">
                {iconLabel(draft.trim())}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => pick('')}
            >
              清空
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">上传</div>
          {uploadError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              {uploadError}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.svg"
              className="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0] ?? null
                e.currentTarget.value = ''
                if (!file) return
                upload(file)
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              选择文件…
            </Button>
            <div className="text-xs text-muted-foreground">
              建议 SVG；支持 PNG/JPG/WebP；≤ 256KB
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">地址</div>
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="/icon/openai.svg 或 https://... 或 data:image/..."
            />
            <Button
              type="button"
              onClick={() => pick(draft.trim())}
              disabled={!draft.trim()}
            >
              使用
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            提示：放在 <code className="px-1">web/public/icon/</code> 的 svg 可直接写{' '}
            <code className="px-1">/icon/xxx.svg</code>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">内置图标</div>
            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索…"
                className="h-9 w-44"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {filteredIcons.map((src) => {
              const label = iconLabel(src)
              return (
                <button
                  key={src}
                  type="button"
                  className={cn(
                    'group flex flex-col items-center gap-1 rounded-md border bg-background p-2 text-left transition-colors',
                    'hover:bg-accent/40',
                  )}
                  onClick={() => pick(src)}
                  title={src}
                >
                  <span className="grid size-10 place-items-center rounded-md border bg-card text-foreground">
                    <ProviderLogo src={src} className="size-5" />
                  </span>
                  <span className="w-full truncate text-center text-[11px] text-muted-foreground group-hover:text-foreground">
                    {label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}

type BusyState =
  | null
  | 'load'
  | 'save'
  | 'refreshModels'
  | 'delete'
  | 'addModel'
  | 'removeModel'

const emptyModels: string[] = []
const maxModelNameLength = 200

export default function Providers() {
  const [providers, setProviders] = useState<ProviderDto[]>([])
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState<string | null>(null)

  const [providerQuery, setProviderQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string>(() => {
    const first = providerPresets[0]?.id
    return first ? presetKey(first) : ''
  })
  const selectedRef = useMemo(() => parseSelectedKey(selectedKey), [selectedKey])

  const [presetRequestType, setPresetRequestType] =
    useState<ProviderRequestType>('OpenAI')

  const [customName, setCustomName] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customLogo, setCustomLogo] = useState('')
  const [customRequestType, setCustomRequestType] =
    useState<ProviderRequestType>('OpenAI')
  const [customAzureApiVersion, setCustomAzureApiVersion] = useState('')

  const [createCustomOpen, setCreateCustomOpen] = useState(false)
  const [createCustomError, setCreateCustomError] = useState<string | null>(null)
  const [createCustomName, setCreateCustomName] = useState('')
  const [createCustomBaseUrl, setCreateCustomBaseUrl] = useState('')
  const [createCustomLogo, setCreateCustomLogo] = useState('')
  const [createCustomRequestType, setCreateCustomRequestType] =
    useState<ProviderRequestType>('OpenAI')
  const [createCustomAzureApiVersion, setCreateCustomAzureApiVersion] =
    useState('')
  const [createCustomApiKey, setCreateCustomApiKey] = useState('')
  const [createCustomShowApiKey, setCreateCustomShowApiKey] = useState(false)

  const [iconPickerTarget, setIconPickerTarget] = useState<
    null | 'create' | 'edit'
  >(null)

  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  const [modelQuery, setModelQuery] = useState('')
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [addModelDraft, setAddModelDraft] = useState('')
  const [addModelError, setAddModelError] = useState<string | null>(null)
  const [removeModelTarget, setRemoveModelTarget] = useState<string | null>(null)

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const loading = busy !== null

  const load = useCallback(async () => {
    setBusy('load')
    setError(null)
    try {
      const data = await api.providers.list()
      setProviders(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const selectedPreset = useMemo(() => {
    if (selectedRef?.kind !== 'preset') return null
    return providerPresets.find((p) => p.id === selectedRef.id) ?? null
  }, [selectedRef])

  const providerByPresetId = useMemo(() => {
    const map: Partial<Record<string, ProviderDto>> = {}
    for (const preset of providerPresets) {
      const normalizedPresetUrl = trimTrailingSlash(preset.baseUrl)
      const hit =
        providers.find(
          (p) => trimTrailingSlash(p.address) === normalizedPresetUrl,
        ) ?? null
      if (hit) map[preset.id] = hit
    }
    return map
  }, [providers])

  const customProviders = useMemo(() => {
    return providers.filter(
      (p) => !presetBaseUrlSet.has(trimTrailingSlash(p.address)),
    )
  }, [providers])

  const selectedProvider = useMemo(() => {
    if (!selectedRef) return null
    if (selectedRef.kind === 'custom') {
      return providers.find((p) => p.id === selectedRef.id) ?? null
    }
    if (!selectedPreset) return null
    return providerByPresetId[selectedPreset.id] ?? null
  }, [providerByPresetId, providers, selectedPreset, selectedRef])

  useEffect(() => {
    setApiKey('')
    setShowApiKey(false)
    setModelQuery('')
    setCopiedKey(null)

    if (selectedRef?.kind === 'custom') {
      const hit = providers.find((p) => p.id === selectedRef.id) ?? null
      setCustomName(hit?.name ?? '')
      setCustomBaseUrl(hit?.address ?? '')
      setCustomLogo(hit?.logo ?? '')
      setCustomRequestType(hit?.requestType ?? 'OpenAI')
      setCustomAzureApiVersion(hit?.azureApiVersion ?? '')
    } else {
      setCustomName('')
      setCustomBaseUrl('')
      setCustomLogo('')
      setCustomRequestType('OpenAI')
      setCustomAzureApiVersion('')
    }
  }, [providers, selectedRef])

  useEffect(() => {
    if (selectedRef?.kind !== 'preset') {
      setPresetRequestType('OpenAI')
      return
    }

    const next = selectedProvider?.requestType ?? 'OpenAI'
    if (next === 'OpenAI' || next === 'OpenAIResponses') {
      setPresetRequestType(next)
      return
    }

    setPresetRequestType('OpenAI')
  }, [selectedProvider?.requestType, selectedRef])

  const filteredProviders = useMemo(() => {
    const q = providerQuery.trim().toLowerCase()

    const presetItems: ProviderListItem[] = providerPresets
      .map((p, index) => ({
        key: presetKey(p.id),
        kind: 'preset',
        name: p.name,
        icon: p.icon,
        baseUrl: p.baseUrl,
        configured: providerByPresetId[p.id]?.hasApiKey ?? false,
        sortIndex: index,
        preset: p,
        provider: providerByPresetId[p.id],
      }))

    const customItems: ProviderListItem[] = customProviders.map((p) => ({
      key: customKey(p.id),
      kind: 'custom',
      name: p.name,
      icon: p.logo ?? customProviderFallbackIcon,
      baseUrl: p.address,
      configured: p.hasApiKey,
      sortIndex: 0,
      provider: p,
    }))

    const list = [...presetItems, ...customItems]
      .map((item) => ({
        ...item,
        haystack: `${item.name} ${safeHostname(item.baseUrl)} ${item.baseUrl}`.toLowerCase(),
      }))
      .filter((item) => (q ? item.haystack.includes(q) : true))
      .sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1
        if (a.kind !== b.kind) return a.kind === 'preset' ? -1 : 1
        if (a.kind === 'preset') return a.sortIndex - b.sortIndex
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })

    return list
  }, [customProviders, providerByPresetId, providerQuery])

  useEffect(() => {
    if (!selectedKey) return
    const stillVisible = filteredProviders.some((p) => p.key === selectedKey)
    if (!stillVisible) {
      setSelectedKey(filteredProviders[0]?.key ?? '')
    }
  }, [filteredProviders, selectedKey])

  const canSave = useMemo(() => {
    if (busy) return false
    if (!selectedRef) return false

    if (selectedRef.kind === 'custom') {
      if (!customName.trim()) return false
      if (!customBaseUrl.trim()) return false
    } else {
      if (!selectedPreset) return false
    }

    if (!selectedProvider) return !!apiKey.trim()
    if (!selectedProvider.hasApiKey) return !!apiKey.trim()
    return true
  }, [
    apiKey,
    busy,
    customBaseUrl,
    customName,
    selectedPreset,
    selectedProvider,
    selectedRef,
  ])

  const buildPayload = useCallback(
    (key: string): ProviderUpsertRequest | null => {
      if (!selectedRef) return null
      if (selectedRef.kind === 'preset') {
        if (!selectedPreset) return null
        const requestType = presetRequestType
        const azureApiVersion = null
        return {
          name: selectedPreset.name,
          address: selectedPreset.baseUrl,
          logo: selectedPreset.icon,
          apiKey: key,
          requestType,
          azureApiVersion,
        }
      }

      const azureApiVersion =
        customRequestType === 'AzureOpenAI'
          ? (customAzureApiVersion.trim() ? customAzureApiVersion.trim() : null)
          : null

      return {
        name: customName.trim(),
        address: trimTrailingSlash(customBaseUrl.trim()),
        logo: customLogo.trim() ? customLogo.trim() : null,
        apiKey: key,
        requestType: customRequestType,
        azureApiVersion,
      }
    },
    [
      customAzureApiVersion,
      customBaseUrl,
      customLogo,
      customName,
      customRequestType,
      presetRequestType,
      selectedPreset,
      selectedRef,
    ],
  )

  const save = useCallback(async () => {
    if (selectedRef?.kind === 'custom') {
      const normalizedBaseUrl = trimTrailingSlash(customBaseUrl.trim())
      if (presetBaseUrlSet.has(normalizedBaseUrl)) {
        setError('该 API 地址属于默认提供商，请直接选择预设并填写 ApiKey。')
        return
      }
    }

    const payload = buildPayload(apiKey)
    if (!payload) return

    setBusy('save')
    setError(null)
    try {
      if (selectedProvider) {
        await api.providers.update(selectedProvider.id, payload)
      } else {
        if (!apiKey.trim()) {
          throw new Error('请先输入 ApiKey')
        }
        await api.providers.create(payload)
      }

      setApiKey('')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [apiKey, buildPayload, customBaseUrl, load, selectedProvider, selectedRef])

  const refreshModels = useCallback(async () => {
    const payload = buildPayload(apiKey)
    if (!payload) return

    setBusy('refreshModels')
    setError(null)
    try {
      let id = selectedProvider?.id ?? null
      if (!id) {
        if (!apiKey.trim()) {
          throw new Error('请先输入 ApiKey 并保存后再拉取模型')
        }
        const created = await api.providers.create(payload)
        id = created.id
        setApiKey('')
      }

      await api.providers.refreshModels(id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [apiKey, buildPayload, load, selectedProvider?.id])

  const remove = useCallback(async () => {
    if (selectedRef?.kind !== 'custom') return
    if (!selectedProvider) return
    setBusy('delete')
    setError(null)
    try {
      await api.providers.delete(selectedProvider.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [load, selectedProvider, selectedRef])

  const openCreateCustom = useCallback(() => {
    setCreateCustomError(null)
    setCreateCustomName('')
    setCreateCustomBaseUrl('')
    setCreateCustomLogo('')
    setCreateCustomRequestType('OpenAI')
    setCreateCustomAzureApiVersion('')
    setCreateCustomApiKey('')
    setCreateCustomShowApiKey(false)
    setCreateCustomOpen(true)
  }, [])

  const canCreateCustom = useMemo(() => {
    if (busy) return false
    if (!createCustomName.trim()) return false
    if (!createCustomBaseUrl.trim()) return false
    if (!createCustomApiKey.trim()) return false
    return true
  }, [busy, createCustomApiKey, createCustomBaseUrl, createCustomName])

  const createCustom = useCallback(async () => {
    const normalizedBaseUrl = trimTrailingSlash(createCustomBaseUrl.trim())
    if (presetBaseUrlSet.has(normalizedBaseUrl)) {
      setCreateCustomError('该 API 地址属于默认提供商，请直接选择预设并填写 ApiKey。')
      return
    }

    setBusy('save')
    setCreateCustomError(null)
    try {
      const azureApiVersion =
        createCustomRequestType === 'AzureOpenAI'
          ? (createCustomAzureApiVersion.trim()
              ? createCustomAzureApiVersion.trim()
              : null)
          : null

      const created = await api.providers.create({
        name: createCustomName.trim(),
        address: normalizedBaseUrl,
        logo: createCustomLogo.trim() ? createCustomLogo.trim() : null,
        apiKey: createCustomApiKey,
        requestType: createCustomRequestType,
        azureApiVersion,
      })

      setCreateCustomOpen(false)
      setCreateCustomName('')
      setCreateCustomBaseUrl('')
      setCreateCustomLogo('')
      setCreateCustomRequestType('OpenAI')
      setCreateCustomAzureApiVersion('')
      setCreateCustomApiKey('')
      setCreateCustomShowApiKey(false)
      setProviders((prev) => [...prev, created])
      setSelectedKey(customKey(created.id))
    } catch (e) {
      setCreateCustomError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [
    createCustomApiKey,
    createCustomAzureApiVersion,
    createCustomBaseUrl,
    createCustomLogo,
    createCustomName,
    createCustomRequestType,
  ])

  const copyToClipboard = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((v) => (v === key ? null : v)), 900)
    } catch {
      // ignore
    }
  }, [])

  const openAddModelDialog = useCallback(() => {
    setAddModelDraft('')
    setAddModelError(null)
    setAddModelOpen(true)
  }, [])

  const addModel = useCallback(async () => {
    if (!selectedProvider) {
      setAddModelError('请先保存提供商')
      return
    }

    const model = addModelDraft.trim()
    if (!model) {
      setAddModelError('请输入模型名称')
      return
    }

    if (model.length > maxModelNameLength) {
      setAddModelError('模型名称过长')
      return
    }

    const lower = model.toLowerCase()
    const exists = selectedProvider.models.some(
      (existing) => existing.toLowerCase() === lower,
    )
    if (exists) {
      setAddModelError('模型已存在')
      return
    }

    setBusy('addModel')
    setError(null)
    setAddModelError(null)
    try {
      await api.providers.addModel(selectedProvider.id, { model })
      await load()
      setAddModelOpen(false)
      setAddModelDraft('')
    } catch (e) {
      setAddModelError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [addModelDraft, load, selectedProvider])

  const removeModel = useCallback(
    async (model: string) => {
      if (!selectedProvider) return
      setBusy('removeModel')
      setError(null)
      try {
        await api.providers.removeModel(selectedProvider.id, model)
        await load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [load, selectedProvider],
  )

  const models = selectedProvider?.models ?? emptyModels
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => m.toLowerCase().includes(q))
  }, [modelQuery, models])

  const groupedModels = useMemo(() => {
    const groups = new Map<string, string[]>()
    for (const model of filteredModels) {
      const group = model.includes('/') ? model.split('/')[0] : '模型'
      const list = groups.get(group) ?? []
      list.push(model)
      groups.set(group, list)
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'))
      .map(([group, list]) => ({
        group,
        models: [...new Set(list)].sort((a, b) =>
          a.localeCompare(b, 'zh-Hans-CN'),
        ),
      }))
  }, [filteredModels])

  if (!selectedRef) {
    return (
      <div className="text-sm text-muted-foreground">未找到可用的提供商。</div>
    )
  }

  if (selectedRef.kind === 'preset' && !selectedPreset) {
    return (
      <div className="text-sm text-muted-foreground">未找到可用的提供商预设。</div>
    )
  }

  const selectedDisplayName =
    selectedRef.kind === 'preset'
      ? (selectedPreset?.name ?? '')
      : customName || selectedProvider?.name || ''

  const selectedDisplayIcon =
    selectedRef.kind === 'preset'
      ? (selectedPreset?.icon ?? customProviderFallbackIcon)
      : customLogo.trim() ||
        selectedProvider?.logo ||
        customProviderFallbackIcon

  const selectedDisplayBaseUrl =
    selectedRef.kind === 'preset'
      ? (selectedPreset?.baseUrl ?? '')
      : customBaseUrl || selectedProvider?.address || ''

  const selectedRequestType: ProviderRequestType =
    selectedRef.kind === 'custom'
      ? customRequestType
      : presetRequestType

  const selectedDescription =
    selectedRef.kind === 'preset'
      ? (selectedPreset?.description ??
          `Base URL 固定为官方地址（${selectedPreset?.baseUrl ?? ''}），协议：${requestTypeLabel(selectedRequestType)}。`)
      : `自定义提供商：Base URL 可编辑，协议：${requestTypeLabel(selectedRequestType)}。`

  const azureApiVersionHint =
    selectedRequestType === 'AzureOpenAI'
      ? (selectedRef.kind === 'custom'
          ? customAzureApiVersion.trim() ||
            selectedProvider?.azureApiVersion ||
            ''
          : selectedProvider?.azureApiVersion || '') || '2025-04-01-preview'
      : ''

  const endpointHintLabel =
    selectedRequestType === 'OpenAI'
      ? 'Chat Completions'
      : selectedRequestType === 'OpenAIResponses'
        ? 'Responses'
        : selectedRequestType === 'Anthropic'
          ? 'Messages'
          : 'Deployments'

  const endpointHint = !selectedDisplayBaseUrl
    ? ''
    : selectedRequestType === 'OpenAI'
      ? joinUrl(selectedDisplayBaseUrl, '/chat/completions')
      : selectedRequestType === 'OpenAIResponses'
        ? joinUrl(selectedDisplayBaseUrl, '/responses')
        : selectedRequestType === 'Anthropic'
          ? joinUrl(selectedDisplayBaseUrl, '/v1/messages')
          : `${trimTrailingSlash(selectedDisplayBaseUrl)}/openai/deployments?api-version=${encodeURIComponent(azureApiVersionHint)}`

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 md:flex-row md:overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col gap-3 md:w-72 md:min-h-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={providerQuery}
            onChange={(e) => setProviderQuery(e.target.value)}
            placeholder="搜索模型提供商..."
            className="pl-9"
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card p-2">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-1">
              {filteredProviders.map((item) => {
                const selected = item.key === selectedKey
                const itemRequestType: ProviderRequestType =
                  item.provider?.requestType ?? 'OpenAI'
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                      selected
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/50',
                    )}
                    onClick={() => setSelectedKey(item.key)}
                    title={item.preset?.description ?? item.provider?.name}
                  >
                    <span className="grid size-7 place-items-center rounded-md border bg-background text-foreground">
                      <ProviderLogo src={item.icon} className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="block min-w-0 flex-1 truncate font-medium">
                          {item.name}
                        </span>
                        {item.kind === 'custom' ? (
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            自定义
                          </Badge>
                        ) : null}
                        <Badge
                          variant="secondary"
                          className="shrink-0 text-[10px]"
                          title={`类型：${itemRequestType}`}
                        >
                          {requestTypeLabel(itemRequestType)}
                        </Badge>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {safeHostname(item.baseUrl)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'ml-2 size-2 shrink-0 rounded-full',
                        item.configured ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                      )}
                      aria-label={item.configured ? '已配置' : '未配置'}
                      title={item.configured ? '已配置' : '未配置'}
                    />
                  </button>
                )
              })}
            </div>
          </div>

          <div className="pt-2">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={openCreateCustom}
              disabled={loading}
            >
              <Plus className="mr-2 size-4" />
              新增自定义
            </Button>
          </div>
        </div>
      </aside>

      <section className="min-w-0 flex-1 min-h-0 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-lg font-semibold">{selectedDisplayName}</div>
              {selectedRef.kind === 'custom' ? (
                <Badge variant="outline">自定义</Badge>
              ) : null}
              <Badge
                variant="secondary"
                title={`requestType: ${selectedRequestType}`}
              >
                {requestTypeLabel(selectedRequestType)}
              </Badge>
              {selectedRef.kind === 'preset' && selectedPreset?.homepage ? (
                <a
                  href={selectedPreset.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                  title="打开官网"
                >
                  <ExternalLink className="size-4" />
                  <span className="sr-only">打开官网</span>
                </a>
              ) : null}
              {selectedProvider?.hasApiKey ? (
                <Badge variant="secondary">已配置</Badge>
              ) : (
                <Badge variant="outline">未配置</Badge>
              )}
            </div>
            <div className="text-sm text-muted-foreground">
              {selectedDescription}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={load}
              disabled={loading}
            >
              <RefreshCcw className="mr-2 size-4" />
              刷新
            </Button>
            {selectedRef.kind === 'custom' && selectedProvider ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={loading}
              >
                <Trash2 className="mr-2 size-4" />
                删除
              </Button>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {error}
          </div>
        ) : null}

        <div className="rounded-lg border bg-card p-4 flex-1 min-h-0">
          <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="flex flex-col items-center justify-center gap-3 py-2 text-center">
              <div className="grid size-16 place-items-center rounded-full border bg-background text-foreground">
                <ProviderLogo src={selectedDisplayIcon} className="size-8" />
              </div>
              <div className="text-xs text-muted-foreground">
                {safeHostname(selectedDisplayBaseUrl)}
              </div>
            </div>

            {selectedRef.kind === 'custom' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-sm font-medium">提供商名称</div>
                  <Input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    disabled={loading}
                    placeholder="例如：My Proxy / Company Gateway"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">图标（可选）</div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setIconPickerTarget('edit')}
                      disabled={loading}
                    >
                      选择/上传
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="grid size-9 place-items-center rounded-md border bg-background text-foreground">
                      <ProviderLogo src={customLogo} className="size-5" />
                    </span>
                    <Input
                      value={customLogo}
                      onChange={(e) => setCustomLogo(e.target.value)}
                      disabled={loading}
                      placeholder="/icon/openai.svg 或 https://... 或上传"
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    提示：放在 web/public/icon/ 的 svg 可直接写 /icon/xxx.svg
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium">提供商类型</div>
                  <Select
                    value={customRequestType}
                    onValueChange={(value) =>
                      setCustomRequestType(value as ProviderRequestType)
                    }
                    disabled={loading}
                  >
                    <SelectTrigger className="h-9 w-full bg-background px-3 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OpenAI">
                        {requestTypeLabel('OpenAI')}
                      </SelectItem>
                      <SelectItem value="OpenAIResponses">
                        {requestTypeLabel('OpenAIResponses')}
                      </SelectItem>
                      <SelectItem value="AzureOpenAI">
                        {requestTypeLabel('AzureOpenAI')}
                      </SelectItem>
                      <SelectItem value="Anthropic">
                        {requestTypeLabel('Anthropic')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {customRequestType === 'AzureOpenAI' ? (
                  <div className="space-y-1">
                    <div className="text-sm font-medium">
                      Azure API Version（可选）
                    </div>
                    <Input
                      value={customAzureApiVersion}
                      onChange={(e) => setCustomAzureApiVersion(e.target.value)}
                      disabled={loading}
                      placeholder="例如：2025-04-01-preview（留空默认）"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedRef.kind === 'preset' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-sm font-medium">提供商类型</div>
                  <Select
                    value={presetRequestType}
                    onValueChange={(value) =>
                      setPresetRequestType(value as ProviderRequestType)
                    }
                    disabled={loading}
                  >
                    <SelectTrigger className="h-9 w-full bg-background px-3 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OpenAI">
                        {requestTypeLabel('OpenAI')}
                      </SelectItem>
                      <SelectItem value="OpenAIResponses">
                        {requestTypeLabel('OpenAIResponses')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="text-xs text-muted-foreground">
                    预设提供商通常为 OpenAI 兼容协议，可选 Chat 或 Responses。
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium">API 密钥</div>
                  {selectedRef.kind === 'preset' && selectedPreset?.homepage ? (
                    <a
                      href={selectedPreset.homepage}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      title="获取 ApiKey"
                    >
                      获取密钥 <ExternalLink className="size-3.5" />
                    </a>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {selectedProvider?.hasApiKey
                    ? `已设置（尾号 ${selectedProvider.apiKeyLast4 ?? ''}）`
                    : '未设置'}
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={loading}
                    placeholder={
                      selectedProvider?.hasApiKey
                        ? '留空则保持不变'
                        : '请输入 ApiKey'
                    }
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={showApiKey ? '隐藏' : '显示'}
                    title={showApiKey ? '隐藏' : '显示'}
                    onClick={() => setShowApiKey((v) => !v)}
                    disabled={loading}
                  >
                    {showApiKey ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => void save()}
                    disabled={!canSave}
                  >
                    保存
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void refreshModels()}
                    disabled={loading}
                    title="尝试拉取模型以验证配置"
                  >
                    检查
                  </Button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                ApiKey 仅用于调用对应提供商接口，OneCode 不会在前端展示完整密钥。
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">API 地址</div>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
                    copiedKey === 'baseUrl' && 'text-foreground',
                  )}
                  onClick={() =>
                    void copyToClipboard('baseUrl', selectedDisplayBaseUrl)
                  }
                  disabled={loading}
                >
                  <Copy className="size-3.5" />
                  {copiedKey === 'baseUrl' ? '已复制' : '复制'}
                </button>
              </div>
              {selectedRef.kind === 'custom' ? (
                <Input
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  disabled={loading}
                  placeholder="例如：https://api.example.com/v1"
                />
              ) : (
                <Input readOnly value={selectedDisplayBaseUrl} />
              )}
              {endpointHint ? (
                <div className="text-xs text-muted-foreground">
                  {endpointHintLabel}：{endpointHint}
                </div>
              ) : null}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">模型</div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={openAddModelDialog}
                    disabled={loading || !selectedProvider}
                    title={
                      selectedProvider ? '手动添加模型到缓存' : '请先保存配置'
                    }
                  >
                    <Plus className="mr-2 size-4" />
                    新增模型
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void refreshModels()}
                    disabled={loading || !selectedProvider}
                    title={
                      selectedProvider ? '拉取 /models 并更新缓存' : '请先保存配置'
                    }
                  >
                    <RefreshCcw className="mr-2 size-4" />
                    拉取模型
                  </Button>
                </div>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="搜索模型..."
                  className="pl-9"
                  disabled={!selectedProvider}
                />
              </div>

              {selectedProvider ? (
                <div className="flex min-h-0 flex-1 flex-col rounded-md border bg-background">
                  <div className="border-b px-3 py-2 text-xs text-muted-foreground">
                    {selectedProvider.models.length
                      ? `已缓存 ${selectedProvider.models.length} 个模型`
                      : '（未拉取）'}
                    {selectedProvider.modelsRefreshedAtUtc ? (
                      <span className="ml-2">
                        更新于 {formatUtc(selectedProvider.modelsRefreshedAtUtc)}
                      </span>
                    ) : null}
                  </div>
                  {selectedProvider.models.length ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <Accordion type="multiple" className="w-full">
                        {groupedModels.map((g) => (
                          <AccordionItem key={g.group} value={g.group}>
                            <AccordionTrigger className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{g.group}</span>
                                <span className="text-xs text-muted-foreground">
                                  {g.models.length}
                                </span>
                              </div>
                            </AccordionTrigger>
                            <AccordionContent className="px-3">
                              <div className="space-y-1">
                                {g.models.map((m) => (
                                  <div
                                    key={m}
                                    className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm"
                                  >
                                    <div className="min-w-0 flex-1 truncate">
                                      {m}
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        className={cn(
                                          'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
                                          copiedKey === m && 'text-foreground',
                                        )}
                                        onClick={() => void copyToClipboard(m, m)}
                                        title="复制模型名"
                                      >
                                        <Copy className="size-3.5" />
                                        {copiedKey === m ? '已复制' : '复制'}
                                      </button>
                                      <button
                                        type="button"
                                        className={cn(
                                          'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-destructive',
                                        )}
                                        onClick={() => setRemoveModelTarget(m)}
                                        title="删除模型"
                                        disabled={loading}
                                      >
                                        <Trash2 className="size-3.5" />
                                        删除
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        ))}
                      </Accordion>
                    </div>
                  ) : (
                    <div className="px-3 py-4 text-sm text-muted-foreground">
                      点击“拉取模型”尝试获取模型列表；部分提供商可能不支持该接口。
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  先保存 ApiKey 后再拉取模型。
                </div>
              )}
            </div>
          </div>
        </div>

        <Modal
          open={createCustomOpen}
          title="新增自定义提供商"
          onClose={() => setCreateCustomOpen(false)}
          className="max-w-3xl"
        >
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              新增一个自定义提供商（支持 OpenAI / OpenAI Responses / Azure OpenAI / Anthropic）。保存后可在左侧列表中选择并管理模型缓存。
            </div>

            {createCustomError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                {createCustomError}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">名称</div>
                <Input
                  value={createCustomName}
                  onChange={(e) => setCreateCustomName(e.target.value)}
                  disabled={loading}
                  placeholder="例如：My Gateway / Company Proxy"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">图标（可选）</div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setIconPickerTarget('create')}
                    disabled={loading}
                  >
                    选择/上传
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="grid size-9 place-items-center rounded-md border bg-background text-foreground">
                    <ProviderLogo src={createCustomLogo} className="size-5" />
                  </span>
                  <Input
                    value={createCustomLogo}
                    onChange={(e) => setCreateCustomLogo(e.target.value)}
                    disabled={loading}
                    placeholder="/icon/openai.svg 或 https://... 或上传"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">提供商类型</div>
                <Select
                  value={createCustomRequestType}
                  onValueChange={(value) =>
                    setCreateCustomRequestType(value as ProviderRequestType)
                  }
                  disabled={loading}
                >
                  <SelectTrigger className="h-9 w-full bg-background px-3 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OpenAI">
                      {requestTypeLabel('OpenAI')}
                    </SelectItem>
                    <SelectItem value="OpenAIResponses">
                      {requestTypeLabel('OpenAIResponses')}
                    </SelectItem>
                    <SelectItem value="AzureOpenAI">
                      {requestTypeLabel('AzureOpenAI')}
                    </SelectItem>
                    <SelectItem value="Anthropic">
                      {requestTypeLabel('Anthropic')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {createCustomRequestType === 'AzureOpenAI' ? (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    Azure API Version（可选）
                  </div>
                  <Input
                    value={createCustomAzureApiVersion}
                    onChange={(e) =>
                      setCreateCustomAzureApiVersion(e.target.value)
                    }
                    disabled={loading}
                    placeholder="例如：2025-04-01-preview（留空默认）"
                  />
                </div>
              ) : null}
            </div>

            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Base URL</div>
              <Input
                value={createCustomBaseUrl}
                onChange={(e) => setCreateCustomBaseUrl(e.target.value)}
                disabled={loading}
                placeholder="例如：https://api.example.com/v1"
              />
            </div>

            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">ApiKey</div>
              <div className="relative">
                <Input
                  type={createCustomShowApiKey ? 'text' : 'password'}
                  value={createCustomApiKey}
                  onChange={(e) => setCreateCustomApiKey(e.target.value)}
                  disabled={loading}
                  placeholder="请输入 ApiKey"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={createCustomShowApiKey ? '隐藏' : '显示'}
                  title={createCustomShowApiKey ? '隐藏' : '显示'}
                  onClick={() => setCreateCustomShowApiKey((v) => !v)}
                  disabled={loading}
                >
                  {createCustomShowApiKey ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateCustomOpen(false)}
                disabled={loading}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => void createCustom()}
                disabled={!canCreateCustom}
              >
                创建
              </Button>
            </div>
          </div>
        </Modal>

        <Modal
          open={addModelOpen}
          title="新增模型"
          onClose={() => {
            setAddModelOpen(false)
            setAddModelDraft('')
            setAddModelError(null)
          }}
          className="max-w-lg"
        >
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              将模型添加到当前提供商缓存（最多 {maxModelNameLength} 个字符）。
            </div>
            <Input
              autoFocus
              value={addModelDraft}
              onChange={(e) => {
                setAddModelDraft(e.target.value)
                if (addModelError) setAddModelError(null)
              }}
              disabled={loading}
              placeholder="例如：gpt-5.1-codex-max"
            />
            {addModelError ? (
              <div className="text-sm text-destructive">{addModelError}</div>
            ) : null}
            {!selectedProvider ? (
              <div className="text-xs text-muted-foreground">
                请先保存提供商配置后再新增模型。
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAddModelOpen(false)
                  setAddModelDraft('')
                  setAddModelError(null)
                }}
                disabled={loading}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => void addModel()}
                disabled={loading || !selectedProvider}
              >
                添加
              </Button>
            </div>
          </div>
        </Modal>

        <IconPickerModal
          open={iconPickerTarget !== null}
          value={
            iconPickerTarget === 'create'
              ? createCustomLogo
              : iconPickerTarget === 'edit'
                ? customLogo
                : ''
          }
          onClose={() => setIconPickerTarget(null)}
          onSelect={(next) => {
            if (iconPickerTarget === 'create') setCreateCustomLogo(next)
            if (iconPickerTarget === 'edit') setCustomLogo(next)
          }}
        />

        <AlertDialog
          open={removeModelTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRemoveModelTarget(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认删除模型</AlertDialogTitle>
              <AlertDialogDescription>
                确定删除模型「{removeModelTarget ?? ''}」？
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={loading || !selectedProvider || !removeModelTarget}
                className={buttonVariants({ variant: 'destructive' })}
                onClick={() => {
                  const target = removeModelTarget
                  setRemoveModelTarget(null)
                  if (target) void removeModel(target)
                }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => setDeleteDialogOpen(open)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认删除自定义提供商</AlertDialogTitle>
              <AlertDialogDescription>
                确定删除自定义提供商「{selectedProvider?.name ?? ''}」？关联项目会自动改为使用默认配置。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={loading || !selectedProvider || selectedRef.kind !== 'custom'}
                className={buttonVariants({ variant: 'destructive' })}
                onClick={() => {
                  setDeleteDialogOpen(false)
                  void remove()
                }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  )
}
