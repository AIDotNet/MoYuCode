import { useEffect, useMemo, useState } from 'react'
import { bundledLanguages, codeToHtml, type BundledLanguage } from 'shiki'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui/spinner'

type LoadState =
  | { status: 'idle' }
  | { status: 'ready'; key: string; html: string }
  | { status: 'error'; key: string; message: string }

function getExtension(filePath: string): string {
  const base = filePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function guessLanguageFromPath(filePath: string): string {
  const ext = getExtension(filePath)
  switch (ext) {
    case 'ts':
      return 'typescript'
    case 'tsx':
      return 'tsx'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'jsx'
    case 'json':
    case 'jsonc':
      return 'json'
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'css'
    case 'html':
    case 'htm':
      return 'html'
    case 'md':
    case 'mdx':
      return 'markdown'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'toml':
      return 'toml'
    case 'ps1':
      return 'powershell'
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash'
    case 'cs':
      return 'csharp'
    case 'sql':
      return 'sql'
    default:
      return 'text'
  }
}

function normalizeBundledLanguage(language: string): BundledLanguage {
  if (language in bundledLanguages) return language as BundledLanguage
  // Shiki supports a built-in plain text mode ("text") even though it isn't part of the
  // BundledLanguage union.
  return 'text' as unknown as BundledLanguage
}

function computeInputKey(code: string, lang: string): string {
  // A fast, deterministic key so we can treat stale renders as "loading" without
  // calling setState synchronously inside an effect (see `react-hooks/set-state-in-effect`).
  let hash = 2166136261
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${lang}:${code.length}:${(hash >>> 0).toString(16)}`
}

export function ShikiCode({
  code,
  filePath,
  language,
  className,
}: {
  code: string
  filePath?: string
  language?: string
  className?: string
}) {
  const lang = useMemo(() => {
    const inferred = language?.trim() ? language.trim() : filePath ? guessLanguageFromPath(filePath) : 'text'
    return normalizeBundledLanguage(inferred)
  }, [filePath, language])

  const inputKey = useMemo(() => computeInputKey(code ?? '', String(lang)), [code, lang])

  const [state, setState] = useState<LoadState>({ status: 'idle' })

  useEffect(() => {
    let canceled = false

    void (async () => {
      try {
        const html = await codeToHtml(code ?? '', {
          lang,
          theme: 'github-dark',
        })
        if (canceled) return
        setState({ status: 'ready', key: inputKey, html })
      } catch (e) {
        if (canceled) return
        setState({ status: 'error', key: inputKey, message: (e as Error).message })
      }
    })()

    return () => {
      canceled = true
    }
  }, [code, inputKey, lang])

  if (state.status === 'error' && state.key === inputKey) {
    return (
      <div className={cn('px-4 py-4 text-xs text-destructive', className)}>
        {state.message || '语法高亮失败'}
      </div>
    )
  }

  if (state.status !== 'ready' || state.key !== inputKey) {
    return (
      <div className={cn('flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground', className)}>
        <span className="inline-flex items-center gap-2">
          <Spinner /> 渲染中…
        </span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'h-full min-h-0 overflow-auto text-xs [&_.shiki]:!bg-transparent [&_.shiki]:min-w-fit [&_.shiki]:p-4',
        className,
      )}
      // Shiki returns safe, static HTML.
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  )
}
