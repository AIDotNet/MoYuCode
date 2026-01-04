import type { ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { ProvidersPage } from '@/pages/ProvidersPage'
import { ProjectWorkspacePage } from '@/pages/ProjectWorkspacePage'
import { ToolPage } from '@/pages/ToolPage'
import { ThemeTogglerButton } from '@animate-ui/components-buttons-theme-toggler'
import { Settings } from 'lucide-react'

function MaskIcon({ src, className }: { src: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-5 bg-current', className)}
      style={{
        maskImage: `url(${src})`,
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
      }}
    />
  )
}

function NavIconLink({
  to,
  label,
  icon,
}: {
  to: string
  label: string
  icon: ReactNode
}) {
  const location = useLocation()
  const active = location.pathname === to

  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-10 items-center justify-center rounded-lg transition-colors',
        active
          ? 'bg-accent text-accent-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </Link>
  )
}

export default function App() {
  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full w-full">
        <aside className="flex w-16 shrink-0 flex-col items-center border-r bg-card px-2 py-4">
          <nav className="flex flex-col items-center gap-2">
            <NavIconLink
              to="/codex"
              label="Codex"
              icon={<MaskIcon src="/code.svg" />}
            />
            <NavIconLink
              to="/claude"
              label="Claude Code"
              icon={<MaskIcon src="/claude-code.svg" />}
            />
            <NavIconLink
              to="/providers"
              label="提供商管理"
              icon={<Settings className="size-5" aria-hidden="true" />}
            />
          </nav>

          <div className="mt-auto">
            <ThemeTogglerButton
              aria-label="切换主题"
              title="切换主题"
              variant="ghost"
              size="lg"
            />
          </div>
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6">
          <Routes>
            <Route path="/" element={<Navigate to="/codex" replace />} />
            <Route path="/codex" element={<ToolPage tool="codex" title="Codex" />} />
            <Route path="/claude" element={<ToolPage tool="claude" title="Claude Code" />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/projects/:id" element={<ProjectWorkspacePage />} />
            <Route path="*" element={<Navigate to="/codex" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
