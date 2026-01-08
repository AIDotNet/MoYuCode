import { memo } from 'react'
import { Tooltip, TooltipContent } from '@/components/animate-ui/primitives/animate/tooltip'
import { MonacoCode } from '@/components/MonacoCode'
import type { ReadToolInput } from '@/lib/toolInputParsers'

interface ReadToolContentProps {
  input: ReadToolInput
  code: string
}

export const ReadToolContent = memo(function ReadToolContent({ input, code }: ReadToolContentProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tooltip side="top" sideOffset={8}>
          <TooltipContent className="max-w-xs break-all">{input.filePath}</TooltipContent>
        </Tooltip>
      </div>
      <div className="h-[240px] overflow-hidden rounded-md border bg-background">
        <MonacoCode
          code={code}
          filePath={input.filePath}
          className="h-full"
        />
      </div>
    </div>
  )
})
