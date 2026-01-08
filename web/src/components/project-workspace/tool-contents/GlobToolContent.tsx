import { memo, useMemo } from 'react'
import { FolderSearch } from 'lucide-react'
import type { GlobToolInput } from '@/lib/toolInputParsers'

interface GlobToolContentProps {
  input: GlobToolInput
  output: string
}

export const GlobToolContent = memo(function GlobToolContent({ input, output }: GlobToolContentProps) {
  const files = useMemo(() => {
    if (!output) return []
    try {
      const parsed = JSON.parse(output)
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === 'string')
      }
      return []
    } catch {
      return []
    }
  }, [output])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <FolderSearch className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">Glob</span>
        </div>
        <div className="flex-1 font-mono text-sm">{input.pattern}</div>
      </div>
      {files.length > 0 && (
        <div className="max-h-[240px] overflow-y-auto rounded-md border bg-background p-2">
          <div className="space-y-1">
            {files.map((file, index) => (
              <div key={index} className="font-mono text-xs text-foreground/90">
                {file}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
