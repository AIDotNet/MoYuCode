import { useMemo } from 'react'
import Editor from '@monaco-editor/react'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui/spinner'
import { ensureMonacoEnvironment } from '@/lib/monaco/monacoEnvironment'

function getExtension(filePath: string): string {
  const base = filePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function guessLanguageFromPath(filePath: string): string {
  const ext = getExtension(filePath)
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
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
      return 'shell'
    case 'cs':
      return 'csharp'
    case 'sql':
      return 'sql'
    default:
      return 'plaintext'
  }
}

export function MonacoCode({
  code,
  filePath,
  language,
  className,
  readOnly = true,
  onChange,
}: {
  code: string
  filePath?: string
  language?: string
  className?: string
  readOnly?: boolean
  onChange?: (value: string) => void
}) {
  ensureMonacoEnvironment()
  const { resolvedTheme } = useTheme()

  const modelPath = useMemo(() => {
    if (!filePath) return undefined
    const normalized = filePath.replace(/\\/g, '/')
    return `inmemory://model/${encodeURIComponent(normalized)}`
  }, [filePath])

  const lang = useMemo(() => {
    if (language?.trim()) return language.trim()
    if (filePath) return guessLanguageFromPath(filePath)
    return 'plaintext'
  }, [filePath, language])

  const theme = resolvedTheme === 'light' ? 'vs' : 'vs-dark'

  return (
    <div className={cn('h-full min-h-0 overflow-hidden', className)}>
      <Editor
        height="100%"
        width="100%"
        value={code ?? ''}
        language={lang}
        path={modelPath}
        saveViewState
        theme={theme}
        onChange={(value) => {
          if (readOnly) return
          onChange?.(value ?? '')
        }}
        loading={
          <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Spinner /> 渲染中…
            </span>
          </div>
        }
        options={{
          readOnly,
          domReadOnly: readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fontSize: 12,
          tabSize: 2,
          overviewRulerBorder: false,
          renderLineHighlight: 'all',
        }}
      />
    </div>
  )
}
