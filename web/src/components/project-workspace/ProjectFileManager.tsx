import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/api/client'
import type { DirectoryEntryDto, FileEntryDto, ListEntriesResponse } from '@/api/types'
import { getVscodeFileIconUrl, getVscodeFolderIconUrls } from '@/lib/vscodeFileIcons'
import {
  FileItem,
  Files,
  FolderContent,
  FolderItem,
  FolderTrigger,
  SubFiles,
} from '@animate-ui/components-base-files'
import { Modal } from '@/components/Modal'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { ProjectFileManagerPanel, type ProjectFileManagerTabKey } from './ProjectFileManagerPanel'
import { ProjectCommitPanel } from './ProjectCommitPanel'

type FsEntryKind = 'file' | 'directory'

type FsEntryTarget = {
  kind: FsEntryKind
  name: string
  fullPath: string
}

function normalizePathForComparison(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

function getParentPath(fullPath: string): string | null {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return null

  const parent = normalized.slice(0, lastSeparator)
  if (!parent) return null
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`
  return parent
}

function getBaseName(fullPath: string): string {
  const normalized = fullPath.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparator < 0) return normalized
  const base = normalized.slice(lastSeparator + 1)
  return base || normalized
}

function splitFileSystemPath(path: string): string[] {
  const normalized = path.replace(/\//g, '\\').replace(/[\\]+$/, '')
  return normalized.split('\\').filter(Boolean)
}

function getRelativePath(fromPath: string, toPath: string): string | null {
  const fromParts = splitFileSystemPath(fromPath)
  const toParts = splitFileSystemPath(toPath)

  if (!fromParts.length || !toParts.length) return null

  const fromRoot = fromParts[0].toLowerCase()
  const toRoot = toParts[0].toLowerCase()
  if (fromRoot !== toRoot) return null

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common].toLowerCase() === toParts[common].toLowerCase()
  ) {
    common += 1
  }

  const up = new Array(Math.max(0, fromParts.length - common)).fill('..')
  const down = toParts.slice(common)
  const combined = [...up, ...down]
  return combined.join('\\') || '.'
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall back
    }
  }

  try {
    if (typeof document === 'undefined') return false
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

function FsContextMenu({
  open,
  x,
  y,
  onClose,
  children,
}: {
  open: boolean
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    const onScroll = () => onClose()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onClose])

  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
      role="presentation"
    >
      <div
        className="fixed min-w-[240px] max-w-[320px] max-h-[calc(100vh-16px)] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

function buildVscodeIconImg(url: string | null | undefined): ReactNode | undefined {
  const normalized = (url ?? '').trim()
  if (!normalized) return undefined

  return (
    <img
      src={normalized}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="size-4.5 shrink-0"
    />
  )
}

export function ProjectFileManager({
  workspacePath,
  projectId,
  className,
  onRequestClose,
  onOpenFile,
  onOpenDiff,
  onOpenTerminal,
}: {
  workspacePath: string
  projectId?: string | null
  className?: string
  onRequestClose: () => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (file: string, opts?: { staged?: boolean }) => void
  onOpenTerminal?: (path: string) => void
}) {
  const [activeTab, setActiveTab] = useState<ProjectFileManagerTabKey>('files')
  const [hasGit, setHasGit] = useState(false)
  const [fsNotice, setFsNotice] = useState<string | null>(null)
  const fsNoticeTimerRef = useRef<number | null>(null)

  const showFsNotice = useCallback((message: string) => {
    setFsNotice(message)
    if (typeof window === 'undefined') return

    if (fsNoticeTimerRef.current) {
      window.clearTimeout(fsNoticeTimerRef.current)
    }

    fsNoticeTimerRef.current = window.setTimeout(() => {
      setFsNotice(null)
      fsNoticeTimerRef.current = null
    }, 1800)
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      if (fsNoticeTimerRef.current) {
        window.clearTimeout(fsNoticeTimerRef.current)
      }
    }
  }, [])

  const [fsMenu, setFsMenu] = useState<{ x: number; y: number; target: FsEntryTarget } | null>(
    null,
  )

  const closeFsMenu = useCallback(() => setFsMenu(null), [])

  const openFsMenu = useCallback((e: ReactMouseEvent, target: FsEntryTarget) => {
    e.preventDefault()
    e.stopPropagation()
    if (typeof window === 'undefined') return

    const menuWidth = 240
    const menuHeight = 320
    const x = Math.min(e.clientX, Math.max(0, window.innerWidth - menuWidth))
    const y = Math.min(e.clientY, Math.max(0, window.innerHeight - menuHeight))
    setFsMenu({ x, y, target })
  }, [])

  const [renameTarget, setRenameTarget] = useState<FsEntryTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<FsEntryTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [createBusy, setCreateBusy] = useState(false)

  const inFlightRef = useRef<Set<string>>(new Set())
  const [entriesByPath, setEntriesByPath] = useState<
    Record<string, Pick<ListEntriesResponse, 'directories' | 'files'>>
  >({})
  const entriesByPathRef = useRef(entriesByPath)
  const [nodeLoadingByPath, setNodeLoadingByPath] = useState<Record<string, boolean>>({})
  const [nodeErrorByPath, setNodeErrorByPath] = useState<Record<string, string | null>>({})

  useEffect(() => {
    entriesByPathRef.current = entriesByPath
  }, [entriesByPath])

  const resetEntries = useCallback(() => {
    inFlightRef.current.clear()
    setEntriesByPath({})
    entriesByPathRef.current = {}
    setNodeLoadingByPath({})
    setNodeErrorByPath({})
  }, [])

  const ensureEntries = useCallback(async (path: string) => {
    const normalizedPath = path.trim()
    if (!normalizedPath) return
    if (entriesByPathRef.current[normalizedPath]) return
    if (inFlightRef.current.has(normalizedPath)) return

    inFlightRef.current.add(normalizedPath)
    setNodeLoadingByPath((s) => ({ ...s, [normalizedPath]: true }))
    setNodeErrorByPath((s) => ({ ...s, [normalizedPath]: null }))
    try {
      const data = await api.fs.listEntries(normalizedPath)
      setEntriesByPath((s) => {
        const next = {
          ...s,
          [normalizedPath]: { directories: data.directories, files: data.files },
          [data.currentPath]: { directories: data.directories, files: data.files },
        }
        entriesByPathRef.current = next
        return next
      })
    } catch (e) {
      setNodeErrorByPath((s) => ({ ...s, [normalizedPath]: (e as Error).message }))
    } finally {
      inFlightRef.current.delete(normalizedPath)
      setNodeLoadingByPath((s) => ({ ...s, [normalizedPath]: false }))
    }
  }, [])

  const invalidateFsCache = useCallback(
    (changedPath: string) => {
      const changedNorm = normalizePathForComparison(changedPath)
      const parentPath = getParentPath(changedPath)
      const parentNorm = parentPath ? normalizePathForComparison(parentPath) : null

      const shouldRemove = (key: string) => {
        const keyNorm = normalizePathForComparison(key)
        if (parentNorm && keyNorm === parentNorm) return true
        if (keyNorm === changedNorm) return true
        return keyNorm.startsWith(`${changedNorm}\\`) || keyNorm.startsWith(`${changedNorm}/`)
      }

      setEntriesByPath((s) => {
        const next: typeof s = {}
        for (const [key, value] of Object.entries(s)) {
          if (!shouldRemove(key)) next[key] = value
        }
        entriesByPathRef.current = next
        return next
      })

      setNodeLoadingByPath((s) => {
        const next: typeof s = {}
        for (const [key, value] of Object.entries(s)) {
          if (!shouldRemove(key)) next[key] = value
        }
        return next
      })

      setNodeErrorByPath((s) => {
        const next: typeof s = {}
        for (const [key, value] of Object.entries(s)) {
          if (!shouldRemove(key)) next[key] = value
        }
        return next
      })

      if (parentPath) {
        void ensureEntries(parentPath)
      }
    },
    [ensureEntries],
  )

  const handleCopyPath = useCallback(
    async (path: string) => {
      const ok = await copyTextToClipboard(path)
      showFsNotice(ok ? '已复制绝对路径' : '复制失败：请手动复制')
    },
    [showFsNotice],
  )

  const handleCopyRelativePath = useCallback(
    async (path: string) => {
      const root = workspacePath.trim()
      if (!root) {
        await handleCopyPath(path)
        return
      }

      const relative = getRelativePath(root, path)
      if (!relative) {
        await handleCopyPath(path)
        showFsNotice('已复制绝对路径（无法计算相对路径）')
        return
      }

      const ok = await copyTextToClipboard(relative)
      showFsNotice(ok ? '已复制相对路径' : '复制失败：请手动复制')
    },
    [handleCopyPath, showFsNotice, workspacePath],
  )

  const handleRevealInExplorer = useCallback(
    async (path: string) => {
      try {
        await api.fs.revealInExplorer(path)
      } catch (e) {
        showFsNotice((e as Error).message)
      }
    },
    [showFsNotice],
  )

  const handleOpenTerminal = useCallback(
    async (path: string) => {
      if (onOpenTerminal) {
        onOpenTerminal(path)
        return
      }
      try {
        await api.fs.openTerminal(path)
      } catch (e) {
        showFsNotice((e as Error).message)
      }
    },
    [onOpenTerminal, showFsNotice],
  )

  const handleCopyName = useCallback(
    async (name: string) => {
      const ok = await copyTextToClipboard(name)
      showFsNotice(ok ? '已复制名称' : '复制失败：请手动复制')
    },
    [showFsNotice],
  )

  useEffect(() => {
    resetEntries()
    setActiveTab('files')
    const rootPath = workspacePath.trim()
    setHasGit(false)
    if (!rootPath) return
    void ensureEntries(rootPath)
  }, [ensureEntries, resetEntries, workspacePath])

  const rootPath = workspacePath.trim()
  const rootEntries = rootPath ? entriesByPath[rootPath] : undefined

  useEffect(() => {
    const rootPath = workspacePath.trim()
    if (!rootPath) return

    let canceled = false
    void (async () => {
      try {
        const has = await api.fs.hasGitRepo(rootPath)
        if (!canceled) setHasGit(has)
      } catch {
        if (!canceled) setHasGit(false)
      }
    })()

    return () => {
      canceled = true
    }
  }, [workspacePath])

  const handleCreateEntryAndRename = useCallback(
    async (kind: FsEntryKind, anchor: FsEntryTarget) => {
      if (createBusy) return

      const parentPath =
        anchor.kind === 'directory' ? anchor.fullPath : getParentPath(anchor.fullPath)
      if (!parentPath) {
        showFsNotice('无法确定父目录')
        return
      }

      const defaultName = kind === 'directory' ? '新建文件夹' : '新建文件.txt'
      const existing = entriesByPathRef.current[parentPath]
      const used = new Set<string>()
      if (existing) {
        for (const d of existing.directories) used.add(d.name.toLowerCase())
        for (const f of existing.files) used.add(f.name.toLowerCase())
      }

      const makeCandidate = (index: number) => {
        if (index <= 0) return defaultName
        if (kind === 'directory') return `${defaultName} (${index})`

        const dot = defaultName.lastIndexOf('.')
        if (dot > 0) {
          const base = defaultName.slice(0, dot)
          const ext = defaultName.slice(dot)
          return `${base} (${index})${ext}`
        }
        return `${defaultName} (${index})`
      }

      setCreateBusy(true)
      try {
        let createdPath: string | null = null
        for (let i = 0; i < 50; i += 1) {
          const candidate = makeCandidate(i)
          if (used.has(candidate.toLowerCase())) continue

          try {
            const created = await api.fs.createEntry({ parentPath, name: candidate, kind })
            createdPath = created.fullPath
            break
          } catch (e) {
            const message = (e as Error).message
            if (message.includes('Destination already exists')) continue
            throw e
          }
        }

        if (!createdPath) {
          showFsNotice('创建失败：名称冲突')
          return
        }

        invalidateFsCache(createdPath)

        const createdName = getBaseName(createdPath)
        setRenameTarget({ kind, name: createdName, fullPath: createdPath })
        setRenameDraft(createdName)
        setRenameBusy(false)
        setRenameError(null)
      } catch (e) {
        showFsNotice((e as Error).message)
      } finally {
        setCreateBusy(false)
      }
    },
    [createBusy, invalidateFsCache, showFsNotice],
  )

  const beginRename = useCallback((target: FsEntryTarget) => {
    setRenameTarget(target)
    setRenameDraft(target.name)
    setRenameBusy(false)
    setRenameError(null)
  }, [])

  const submitRename = useCallback(async () => {
    if (!renameTarget) return

    const newName = renameDraft.trim()
    if (!newName) {
      setRenameError('名称不能为空')
      return
    }

    if (newName === renameTarget.name) {
      setRenameTarget(null)
      setRenameError(null)
      return
    }

    setRenameBusy(true)
    setRenameError(null)
    try {
      await api.fs.renameEntry({ path: renameTarget.fullPath, newName })
      invalidateFsCache(renameTarget.fullPath)
      setRenameTarget(null)
      setRenameDraft('')
      showFsNotice('已重命名')
    } catch (e) {
      setRenameError((e as Error).message)
    } finally {
      setRenameBusy(false)
    }
  }, [invalidateFsCache, renameDraft, renameTarget, showFsNotice])

  const beginDelete = useCallback((target: FsEntryTarget) => {
    setDeleteTarget(target)
    setDeleteBusy(false)
    setDeleteError(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return

    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await api.fs.deleteEntry(deleteTarget.fullPath)
      invalidateFsCache(deleteTarget.fullPath)
      setDeleteTarget(null)
      showFsNotice('已删除')
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteTarget, invalidateFsCache, showFsNotice])

  const renderFile = useCallback(
    (file: FileEntryDto) => {
      const iconUrl = getVscodeFileIconUrl(file.name)
      return (
        <FileItem
          key={file.fullPath}
          icon={iconUrl ? buildVscodeIconImg(iconUrl) : undefined}
          onClick={() => onOpenFile?.(file.fullPath)}
          onDoubleClick={() => onOpenFile?.(file.fullPath)}
          onContextMenu={(e) => openFsMenu(e, { kind: 'file', name: file.name, fullPath: file.fullPath })}
        >
          {file.name}
        </FileItem>
      )
    },
    [onOpenFile, openFsMenu],
  )

  const renderDirectory = useCallback(
    (dir: DirectoryEntryDto) => {
      const children = entriesByPath[dir.fullPath]
      const nodeLoading = Boolean(nodeLoadingByPath[dir.fullPath])
      const nodeError = nodeErrorByPath[dir.fullPath]
      const icons = getVscodeFolderIconUrls(dir.name)

      return (
        <FolderItem key={dir.fullPath} value={dir.fullPath}>
          <FolderTrigger
            closeIcon={buildVscodeIconImg(icons.closed)}
            openIcon={buildVscodeIconImg(icons.open)}
            onClick={(e) => {
              e.stopPropagation()
              void ensureEntries(dir.fullPath)
            }}
            onContextMenu={(e) =>
              openFsMenu(e, { kind: 'directory', name: dir.name, fullPath: dir.fullPath })
            }
          >
            {dir.name}
          </FolderTrigger>

          <FolderContent>
            {nodeError ? <div className="px-2 py-2 text-sm text-destructive">{nodeError}</div> : null}

            {nodeLoading ? (
              <div className="px-2 py-2 text-sm text-muted-foreground">加载中…</div>
            ) : null}

            {!nodeLoading && children ? (
              <div className="space-y-1">
                {children.directories.length || children.files.length ? null : (
                  <div className="px-2 py-2 text-sm text-muted-foreground">暂无内容</div>
                )}

                {children.directories.length ? (
                  <SubFiles>{children.directories.map(renderDirectory)}</SubFiles>
                ) : null}

                {children.files.length ? <div className="px-2">{children.files.map(renderFile)}</div> : null}
              </div>
            ) : null}
          </FolderContent>
        </FolderItem>
      )
    },
    [ensureEntries, entriesByPath, nodeErrorByPath, nodeLoadingByPath, openFsMenu, renderFile],
  )

  const rootFilesView = useMemo(() => {
    if (!rootPath) {
      return <div className="px-4 py-6 text-sm text-muted-foreground">未设置工作空间</div>
    }

    const nodeLoading = Boolean(nodeLoadingByPath[rootPath])
    const nodeError = nodeErrorByPath[rootPath]
    if (nodeError) {
      return <div className="px-4 py-6 text-sm text-destructive">{nodeError}</div>
    }

    if (nodeLoading || !rootEntries) {
      return <div className="px-4 py-6 text-sm text-muted-foreground">加载中…</div>
    }

    if (!rootEntries.directories.length && !rootEntries.files.length) {
      return <div className="px-4 py-6 text-sm text-muted-foreground">暂无文件</div>
    }

    return (
      <div className="h-full overflow-auto">
        <Files>
          {rootEntries.directories.map(renderDirectory)}
          {rootEntries.files.map(renderFile)}
        </Files>
      </div>
    )
  }, [nodeErrorByPath, nodeLoadingByPath, renderDirectory, renderFile, rootEntries, rootPath])

  const commitView = useMemo(() => {
    if (!hasGit) {
      return (
        <div className="h-full min-h-0 overflow-auto px-4 py-6 text-sm text-muted-foreground">
          当前工作区不是 Git 仓库。
        </div>
      )
    }

    return (
      <ProjectCommitPanel workspacePath={workspacePath} projectId={projectId} onOpenDiff={onOpenDiff} />
    )
  }, [hasGit, onOpenDiff, projectId, workspacePath])

  return (
    <>
      <ProjectFileManagerPanel
        className={className}
        notice={fsNotice}
        hasGit={hasGit}
        activeTab={activeTab}
        onTabChange={(tab) => {
          if (tab === 'commit' && !hasGit) return
          setActiveTab(tab)
        }}
        onRequestClose={onRequestClose}
        filesView={
          <div
            className="h-full min-h-0 overflow-hidden"
            onContextMenu={(e) => {
              if (!rootPath) return
              openFsMenu(e, {
                kind: 'directory',
                name: getBaseName(rootPath),
                fullPath: rootPath,
              })
            }}
          >
            {rootFilesView}
          </div>
        }
        commitView={commitView}
      />

      <FsContextMenu
        open={Boolean(fsMenu)}
        x={fsMenu?.x ?? 0}
        y={fsMenu?.y ?? 0}
        onClose={closeFsMenu}
      >
        <div className="p-1">
          <div className="px-2 py-1 text-xs text-muted-foreground truncate">{fsMenu?.target.name}</div>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleRevealInExplorer(target.fullPath)
            }}
          >
            {fsMenu?.target.kind === 'directory' ? '在资源管理器中打开' : '在资源管理器中显示'}
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              const path =
                target.kind === 'file'
                  ? getParentPath(target.fullPath) ?? target.fullPath
                  : target.fullPath
              void handleOpenTerminal(path)
            }}
          >
            在终端打开
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCopyPath(target.fullPath)
            }}
          >
            复制绝对路径
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCopyRelativePath(target.fullPath)
            }}
          >
            复制相对路径
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCopyName(target.name)
            }}
          >
            {fsMenu?.target.kind === 'directory' ? '复制文件夹名' : '复制文件名'}
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCreateEntryAndRename('file', target)
            }}
          >
            新建文件
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              void handleCreateEntryAndRename('directory', target)
            }}
          >
            新建文件夹
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              beginRename(target)
            }}
          >
            重命名
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            onClick={() => {
              const target = fsMenu?.target
              if (!target) return
              closeFsMenu()
              beginDelete(target)
            }}
          >
            删除
          </button>
        </div>
      </FsContextMenu>

      <Modal
        open={Boolean(renameTarget)}
        title={renameTarget?.kind === 'directory' ? '重命名文件夹' : '重命名文件'}
        onClose={() => {
          if (renameBusy) return
          setRenameTarget(null)
          setRenameDraft('')
          setRenameError(null)
        }}
      >
        <div className="space-y-3">
          {renameTarget ? (
            <div className="text-xs text-muted-foreground break-all">{renameTarget.fullPath}</div>
          ) : null}
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            autoFocus
            disabled={renameBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitRename()
              }
            }}
          />
          {renameError ? <div className="text-sm text-destructive">{renameError}</div> : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (renameBusy) return
                setRenameTarget(null)
                setRenameDraft('')
                setRenameError(null)
              }}
              disabled={renameBusy}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void submitRename()}
              disabled={renameBusy || !renameDraft.trim()}
            >
              确定
            </Button>
          </div>
        </div>
      </Modal>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (open) return
          if (deleteBusy) return
          setDeleteTarget(null)
          setDeleteError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除{deleteTarget?.kind === 'directory' ? '文件夹' : '文件'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除 “{deleteTarget?.name}” 吗？该操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget ? (
            <div className="text-xs text-muted-foreground break-all">{deleteTarget.fullPath}</div>
          ) : null}
          {deleteError ? <div className="text-sm text-destructive">{deleteError}</div> : null}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteBusy}
              onClick={() => {
                if (deleteBusy) return
                setDeleteTarget(null)
                setDeleteError(null)
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void confirmDelete()}
            >
              删除
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
