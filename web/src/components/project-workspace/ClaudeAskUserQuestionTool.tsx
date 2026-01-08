import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import type { AskUserQuestionToolInput, AskUserQuestionToolQuestion, AskUserQuestionToolOption } from '@/components/project-workspace/tool-inputs/askType'

const askUserQuestionOtherValue = '__other__'

type AskUserQuestionAnswerDraft = {
  selectedValues: string[]
  otherText: string
}

function getAskUserQuestionOptionValue(option: AskUserQuestionToolOption): string {
  const value = (option.value ?? '').trim()
  return value || option.label.trim()
}

function buildAskUserQuestionAnswerText(
  question: AskUserQuestionToolQuestion,
  draft: AskUserQuestionAnswerDraft | undefined,
): string {
  if (!draft) return ''
  const selected = draft.selectedValues ?? []
  const otherText = (draft.otherText ?? '').trim()

  if (question.multiSelect) {
    const explicit = selected.filter((v) => v && v !== askUserQuestionOtherValue)
    const parts = selected.includes(askUserQuestionOtherValue)
      ? otherText
        ? [...explicit, otherText]
        : explicit
      : explicit
    return parts.join(', ')
  }

  const first = selected[0] ?? ''
  if (first === askUserQuestionOtherValue) return otherText
  return first
}

export interface ClaudeAskUserQuestionToolProps {
  input: AskUserQuestionToolInput
  disabled: boolean
  onSubmit: (answers: Record<string, string>) => void
}

export const ClaudeAskUserQuestionTool = memo(function ClaudeAskUserQuestionTool({
  input,
  disabled,
  onSubmit,
}: ClaudeAskUserQuestionToolProps) {
  const questionKey = useMemo(
    () => input.questions.map((q) => q.question).join('\n'),
    [input.questions],
  )

  const [draftByQuestion, setDraftByQuestion] = useState<Record<string, AskUserQuestionAnswerDraft>>({})
  const [submitted, setSubmitted] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setSubmitted(false)
    setConfirmOpen(false)
    setDraftByQuestion((prev) => {
      const next: Record<string, AskUserQuestionAnswerDraft> = {}
      for (const q of input.questions) {
        next[q.question] = prev[q.question] ?? { selectedValues: [], otherText: '' }
      }
      return next
    })
  }, [questionKey, input.questions])

  const setSelectedValues = useCallback(
    (question: AskUserQuestionToolQuestion, value: string) => {
      setDraftByQuestion((prev) => {
        const existing = prev[question.question] ?? { selectedValues: [], otherText: '' }
        const selected = existing.selectedValues ?? []
        const nextSelected = question.multiSelect
          ? selected.includes(value)
            ? selected.filter((v) => v !== value)
            : [...selected, value]
          : [value]

        const shouldClearOther = !nextSelected.includes(askUserQuestionOtherValue)
        return {
          ...prev,
          [question.question]: {
            selectedValues: nextSelected,
            otherText: shouldClearOther ? '' : existing.otherText,
          },
        }
      })
    },
    [setDraftByQuestion],
  )

  const setOtherText = useCallback(
    (questionText: string, nextText: string) => {
      setDraftByQuestion((prev) => ({
        ...prev,
        [questionText]: {
          ...(prev[questionText] ?? { selectedValues: [], otherText: '' }),
          otherText: nextText,
        },
      }))
    },
    [setDraftByQuestion],
  )

  const allAnswered = useMemo(() => {
    return input.questions.every((q) => {
      const answer = buildAskUserQuestionAnswerText(q, draftByQuestion[q.question])
      return Boolean(answer.trim())
    })
  }, [draftByQuestion, input.questions])

  const submit = useCallback(() => {
    const answers: Record<string, string> = {}
    for (const q of input.questions) {
      const answer = buildAskUserQuestionAnswerText(q, draftByQuestion[q.question]).trim()
      if (answer) {
        const key = (q.header ?? '').trim() || q.question
        answers[key] = answer
      }
    }
    setSubmitted(true)
    onSubmit(answers)
    setConfirmOpen(false)
  }, [draftByQuestion, input.questions, onSubmit])

  const requestSubmit = useCallback(() => {
    if (disabled || submitted || !allAnswered) return
    setConfirmOpen(true)
  }, [allAnswered, disabled, submitted])

  return (
    <div className="space-y-3">
      <div className="text-[11px] font-medium text-muted-foreground">AskUserQuestion</div>
      {input.questions.map((q) => {
        const draft = draftByQuestion[q.question]
        const selectedValues = draft?.selectedValues ?? []
        const otherSelected = selectedValues.includes(askUserQuestionOtherValue)
        const options = q.options.map((o) => ({
          ...o,
          resolvedValue: getAskUserQuestionOptionValue(o),
        }))
        const optionInputType = q.multiSelect ? 'checkbox' : 'radio'
        const effectiveDisabled = disabled || submitted

        return (
          <div key={q.question} className="space-y-2 rounded-md border bg-background/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              {q.header ? (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {q.header}
                </Badge>
              ) : null}
              {q.multiSelect ? (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                  multi_select
                </Badge>
              ) : null}
            </div>

            <div className="text-sm">{q.question}</div>

            <div className="space-y-1.5">
              {options.map((o) => {
                const isSelected = selectedValues.includes(o.resolvedValue)
                return (
                  <label
                    key={o.resolvedValue}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors',
                      isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
                      effectiveDisabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type={optionInputType}
                      name={q.question}
                      value={o.resolvedValue}
                      disabled={effectiveDisabled}
                      checked={isSelected}
                      onChange={() => setSelectedValues(q, o.resolvedValue)}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="block text-sm font-medium text-foreground">{o.label}</span>
                      {o.description ? (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {o.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                )
              })}

              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors',
                  otherSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
                  effectiveDisabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type={optionInputType}
                  name={q.question}
                  value={askUserQuestionOtherValue}
                  disabled={effectiveDisabled}
                  checked={otherSelected}
                  onChange={() => setSelectedValues(q, askUserQuestionOtherValue)}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-sm font-medium text-foreground">Other</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {q.multiSelect ? 'Optional: add a custom choice.' : 'Enter a custom choice.'}
                  </span>
                  <Input
                    value={draft?.otherText ?? ''}
                    disabled={effectiveDisabled}
                    placeholder="Enter a custom value"
                    onFocus={() => {
                      if (!otherSelected) {
                        setSelectedValues(q, askUserQuestionOtherValue)
                      }
                    }}
                    onChange={(e) => {
                      if (!otherSelected) {
                        setSelectedValues(q, askUserQuestionOtherValue)
                      }
                      setOtherText(q.question, e.target.value)
                    }}
                  />
                </span>
              </label>
            </div>
          </div>
        )
      })}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="sm" disabled={disabled || submitted || !allAnswered} onClick={requestSubmit}>
          Submit
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit answers?</AlertDialogTitle>
            <AlertDialogDescription>
              Answers are sent via A2A and cannot be intercepted or cancelled once submitted. Confirm before sending.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={disabled || submitted || !allAnswered}>
              Confirm submit
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
