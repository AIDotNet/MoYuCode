import {
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from 'vscode-icons-ts'

// 使用 Vite 的 import.meta.glob 导入所有图标
// 注意：路径是相对于当前文件的
const iconModules = import.meta.glob<{ default: string }>(
  '/node_modules/vscode-icons-ts/build/icons/*.svg',
  {
    eager: true,
    query: '?url',
  },
)

// 构建图标名称到 URL 的映射
const iconUrlByName: Record<string, string> = {}
for (const [path, module] of Object.entries(iconModules)) {
  const fileName = path.split('/').pop()
  if (fileName) {
    iconUrlByName[fileName] = module.default
  }
}

export function resolveVscodeIconUrl(iconFile: string | null | undefined): string | null {
  const normalized = (iconFile ?? '').trim()
  if (!normalized) return null
  return iconUrlByName[normalized] ?? null
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
