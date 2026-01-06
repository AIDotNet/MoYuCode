import {
  CHAT_PROMPT_XML,
  escapeXmlAttribute,
  wrapInCdata,
  type CodeSelection,
  type WorkspaceFileRef,
} from './chatPromptXml'

type WorkspaceContextInput = {
  activeFile?: WorkspaceFileRef
  selections?: CodeSelection[]
  files?: WorkspaceFileRef[]
}

export function buildWorkspaceContextXml(input: WorkspaceContextInput): string {
  const activeFilePath = (input.activeFile?.filePath ?? '').trim()
  const selections = input.selections ?? []
  const files = input.files ?? []
  if (!activeFilePath && !selections.length && !files.length) return ''

  const blocks: string[] = []

  if (activeFilePath) {
    blocks.push(
      `  <${CHAT_PROMPT_XML.activeFileTag} ${CHAT_PROMPT_XML.attrFilePath}="${escapeXmlAttribute(activeFilePath)}" />`,
    )
  }

  const seenFiles = new Set<string>()
  for (const file of files) {
    const filePath = (file.filePath ?? '').trim()
    if (!filePath) continue

    const key = filePath.toLowerCase()
    if (seenFiles.has(key)) continue
    seenFiles.add(key)

    blocks.push(
      `  <${CHAT_PROMPT_XML.fileTag} ${CHAT_PROMPT_XML.attrFilePath}="${escapeXmlAttribute(filePath)}" />`,
    )
  }

  for (const selection of selections) {
    const filePath = (selection.filePath ?? '').trim()
    if (!filePath) continue

    const startLine = Math.min(selection.startLine, selection.endLine)
    const endLine = Math.max(selection.startLine, selection.endLine)
    const attrs = [
      `${CHAT_PROMPT_XML.attrFilePath}="${escapeXmlAttribute(filePath)}"`,
      `${CHAT_PROMPT_XML.attrStartLine}="${String(startLine)}"`,
      `${CHAT_PROMPT_XML.attrEndLine}="${String(endLine)}"`,
    ].join(' ')

    blocks.push(
      [
        `  <${CHAT_PROMPT_XML.selectionTag} ${attrs}>`,
        `    <${CHAT_PROMPT_XML.codeTag}>${wrapInCdata(selection.text)}</${CHAT_PROMPT_XML.codeTag}>`,
        `  </${CHAT_PROMPT_XML.selectionTag}>`,
      ].join('\n'),
    )
  }

  if (!blocks.length) return ''
  return `<${CHAT_PROMPT_XML.contextTag}>\n${blocks.join('\n')}\n</${CHAT_PROMPT_XML.contextTag}>`
}

export function buildUserPromptWithWorkspaceContext(
  userMessage: string,
  input: WorkspaceContextInput,
): string {
  const message = (userMessage ?? '').trim()
  const context = buildWorkspaceContextXml(input)
  if (!context) return message
  if (!message) return context
  return `${context}\n\n${message}`
}
