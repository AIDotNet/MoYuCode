export type CodeSelection = {
  filePath: string
  startLine: number
  endLine: number
  text: string
}

export type WorkspaceFileRef = {
  filePath: string
}

export const CHAT_PROMPT_XML = {
  contextTag: 'onecode_context',
  activeFileTag: 'active_file',
  fileTag: 'file',
  selectionTag: 'selection',
  codeTag: 'code',
  attrFilePath: 'path',
  attrStartLine: 'startLine',
  attrEndLine: 'endLine',
} as const

export function escapeXmlAttribute(value: string): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function wrapInCdata(value: string): string {
  const raw = value ?? ''
  if (!raw) return '<![CDATA[]]>'
  return `<![CDATA[${raw.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

export function buildCodeContextXml(selections: CodeSelection[]): string {
  if (!selections.length) return ''

  const body = selections
    .map((selection) => {
      const startLine = Math.min(selection.startLine, selection.endLine)
      const endLine = Math.max(selection.startLine, selection.endLine)
      const attrs = [
        `${CHAT_PROMPT_XML.attrFilePath}="${escapeXmlAttribute(selection.filePath)}"`,
        `${CHAT_PROMPT_XML.attrStartLine}="${String(startLine)}"`,
        `${CHAT_PROMPT_XML.attrEndLine}="${String(endLine)}"`,
      ].join(' ')

      return [
        `  <${CHAT_PROMPT_XML.selectionTag} ${attrs}>`,
        `    <${CHAT_PROMPT_XML.codeTag}>${wrapInCdata(selection.text)}</${CHAT_PROMPT_XML.codeTag}>`,
        `  </${CHAT_PROMPT_XML.selectionTag}>`,
      ].join('\n')
    })
    .join('\n')

  return `<${CHAT_PROMPT_XML.contextTag}>\n${body}\n</${CHAT_PROMPT_XML.contextTag}>`
}

export function buildUserPromptWithCodeContext(
  userMessage: string,
  selections: CodeSelection[],
): string {
  const message = (userMessage ?? '').trim()
  const context = buildCodeContextXml(selections)
  if (!context) return message
  if (!message) return context
  return `${context}\n\n${message}`
}
