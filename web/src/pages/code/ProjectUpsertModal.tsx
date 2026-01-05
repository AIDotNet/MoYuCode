import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/api/client'
import type { ProjectDto, ProviderDto, ToolType } from '@/api/types'
import { DirectoryPicker } from '@/components/DirectoryPicker'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type FormState = {
  toolType: ToolType
  name: string
  workspacePath: string
  providerId: string | null
  model: string
}

function emptyForm(toolType: ToolType): FormState {
  return { toolType, name: '', workspacePath: '', providerId: null, model: '' }
}

export function ProjectUpsertModal({
  open,
  mode,
  project,
  defaultToolType,
  onClose,
  onSaved,
}: {
  open: boolean
  mode: 'create' | 'edit'
  project: ProjectDto | null
  defaultToolType: ToolType
  onClose: () => void
  onSaved: (project: ProjectDto) => void
}) {
  const [providers, setProviders] = useState<ProviderDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState<FormState>(() => emptyForm(defaultToolType))

  useEffect(() => {
    if (!open) return
    setError(null)
    setLoading(false)
    setForm(() => {
      if (mode === 'edit' && project) {
        return {
          toolType: project.toolType,
          name: project.name ?? '',
          workspacePath: project.workspacePath ?? '',
          providerId: project.providerId ?? null,
          model: project.model ?? '',
        }
      }
      return emptyForm(defaultToolType)
    })
  }, [defaultToolType, mode, open, project])

  const loadProviders = useCallback(async () => {
    try {
      const prov = await api.providers.list()
      setProviders(prov)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadProviders()
  }, [loadProviders, open])

  const filteredProviders = useMemo(() => {
    if (form.toolType === 'ClaudeCode') {
      return providers.filter((p) => p.requestType === 'Anthropic')
    }
    return providers
  }, [form.toolType, providers])

  const selectedProvider = useMemo(() => {
    if (!form.providerId) return null
    return filteredProviders.find((p) => p.id === form.providerId) ?? null
  }, [filteredProviders, form.providerId])

  const modelDatalistId = useMemo(() => {
    if (!selectedProvider) return 'models-datalist'
    return `models-datalist-${selectedProvider.id}`
  }, [selectedProvider])

  const canSubmit = useMemo(() => {
    if (!form.name.trim()) return false
    if (!form.workspacePath.trim()) return false
    return true
  }, [form.name, form.workspacePath])

  const submit = useCallback(async () => {
    if (!canSubmit) return

    setLoading(true)
    setError(null)
    try {
      const payload = {
        toolType: form.toolType,
        name: form.name.trim(),
        workspacePath: form.workspacePath.trim(),
        providerId: form.providerId ? form.providerId : null,
        model: form.model.trim() ? form.model.trim() : null,
      }

      const saved =
        mode === 'edit' && project
          ? await api.projects.update(project.id, payload)
          : await api.projects.create(payload)
      onSaved(saved)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [canSubmit, form.model, form.name, form.providerId, form.toolType, form.workspacePath, mode, onSaved, project])

  return (
    <Modal
      open={open}
      title={mode === 'edit' ? '编辑项目' : '新建项目'}
      onClose={() => {
        if (loading) return
        onClose()
      }}
      className="max-w-3xl"
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">工具类型</div>
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.toolType}
              onChange={(e) =>
                setForm((s) => ({ ...s, toolType: e.target.value as ToolType }))
              }
              disabled={loading}
            >
              <option value="Codex">Codex</option>
              <option value="ClaudeCode">Claude Code</option>
            </select>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">项目名</div>
            <Input
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="例如：OneCode"
              disabled={loading}
            />
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">工作空间目录</div>
          <DirectoryPicker
            value={form.workspacePath}
            onChange={(path) => setForm((s) => ({ ...s, workspacePath: path }))}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">绑定提供商（可选）</div>
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.providerId ?? ''}
              onChange={(e) =>
                setForm((s) => ({
                  ...s,
                  providerId: e.target.value ? e.target.value : null,
                }))
              }
              disabled={loading}
            >
              <option value="">默认配置</option>
              {filteredProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.requestType})
                </option>
              ))}
            </select>
            {form.toolType === 'ClaudeCode' ? (
              <div className="text-xs text-muted-foreground">
                Claude Code 仅支持 Anthropic 兼容提供商
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">模型（可选）</div>
            <Input
              list={selectedProvider?.models?.length ? modelDatalistId : undefined}
              value={form.model}
              onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))}
              placeholder={
                selectedProvider
                  ? '可直接输入或从列表选择'
                  : form.toolType === 'Codex'
                    ? '例如：gpt-5.1-codex-max'
                    : '例如：claude-3-5-sonnet-latest'
              }
              disabled={loading}
            />
            {selectedProvider?.models?.length ? (
              <datalist id={modelDatalistId}>
                {selectedProvider.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            ) : null}
          </div>
        </div>

        {error ? <div className="text-sm text-destructive">{error}</div> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit || loading}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}

