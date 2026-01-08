import { memo } from 'react'
import { Terminal } from 'lucide-react'
import { MonacoCode } from '@/components/MonacoCode'
import type { BashToolInput } from '@/lib/toolInputParsers'

interface BashToolContentProps {
  input: BashToolInput
  output: string
}

export const BashToolContent = memo(function BashToolContent({ input, output }: BashToolContentProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Terminal className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">Bash</span>
        </div>
        <div className="flex-1 font-mono text-sm">{input.command}</div>
      </div>
      {input.description && (
        <div className="text-sm text-muted-foreground">{input.description}</div>
      )}
      {output && (
        <div className="h-[240px] overflow-hidden rounded-md border bg-background">
          <MonacoCode
            code={output}
            filePath="output.sh"
            className="h-full"
          />
        </div>
      )}
    </div>
  )
})
