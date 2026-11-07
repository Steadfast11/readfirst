import { FolderKanban, Settings, ShieldBan } from 'lucide-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { NavLink, SignOut } from '@/components/client'
import { currentUser, isDesktop } from '@/server/auth'

const PAGES = [
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/suppression', label: 'Do not contact', icon: ShieldBan },
]

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await currentUser())) redirect('/login')
  const desktop = isDesktop()
  const NAV = desktop ? [...PAGES, { href: '/settings', label: 'Settings', icon: Settings }] : PAGES
  return (
    <div className="tablet:grid tablet:min-h-dvh tablet:grid-cols-[4rem_1fr] desktop:grid-cols-[14rem_1fr]">
      {desktop && <div aria-hidden className="drag" />}
      <aside className={`material chrome sticky top-0 hidden h-dvh flex-col p-3 tablet:flex ${desktop ? 'pt-10' : ''}`}>
        <Link href="/projects" aria-label="Readfirst" className="wordmark mb-6 px-2.5 py-1">
          <span className="desktop:hidden">R</span>
          <span className="hidden desktop:inline">Readfirst</span>
        </Link>
        <nav aria-label="Main" className="flex-1 space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <NavLink key={href} href={href} label={label} pill="side-pill" className="flex min-h-11 items-center gap-2.5 rounded-[14px] px-2.5 py-2 font-medium text-muted hover:text-text aria-[current=page]:text-text">
              <Icon size={18} strokeWidth={2} aria-hidden />
              <span className="hidden desktop:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        {!desktop && <div className="hidden desktop:block "><SignOut /></div>}
      </aside>
      <main className="mx-auto w-full max-w-[70rem] min-w-0 px-4 pt-8 pb-24 tablet:px-8 tablet:pb-10">{children}</main>
      <nav aria-label="Main" className="material dock fixed inset-x-0 bottom-0 flex tablet:hidden">
        {NAV.map(({ href, label, icon: Icon }) => (
          <NavLink key={href} href={href} label={label} pill="dock-pill" className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted aria-[current=page]:text-text">
            <Icon size={20} strokeWidth={2} aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
