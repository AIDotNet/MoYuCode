import {
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from 'vscode-icons-ts'

const iconUrlByPath = import.meta.glob(
  '../node_modules/vscode-icons-ts/build/icons/*.svg',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>

const ICON_DIR = '../node_modules/vscode-icons-ts/build/icons/'

export function resolveVscodeIconUrl(iconFile: string | null | undefined): string | null {
  const normalized = (iconFile ?? '').trim()
  if (!normalized) return null
  return iconUrlByPath[`${ICON_DIR}${normalized}`] ?? null
}

export function getVscodeFileIconUrl(fileName: string): string | null {
  const normalized = fileName.trim()
  if (!normalized) return resolveVscodeIconUrl('default_file.svg')

  const iconFile = getIconForFile(normalized) ?? 'default_file.svg'
  return resolveVscodeIconUrl(iconFile) ?? resolveVscodeIconUrl('default_file.svg')
}

export function getVscodeFolderIconUrls(folderName: string): { closed: string | null; open: string | null } {
  const normalized = folderName.trim()
  if (!normalized) {
    return {
      closed: resolveVscodeIconUrl('default_folder.svg'),
      open: resolveVscodeIconUrl('default_folder_opened.svg'),
    }
  }

  return {
    closed:
      resolveVscodeIconUrl(getIconForFolder(normalized)) ?? resolveVscodeIconUrl('default_folder.svg'),
    open:
      resolveVscodeIconUrl(getIconForOpenFolder(normalized)) ??
      resolveVscodeIconUrl('default_folder_opened.svg'),
  }
}
