import Link from 'next/link'
import type { ReactNode } from 'react'
import { LinkButton } from '@/components/ui'

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-[70rem] items-center justify-between px-4 py-4 tablet:px-6">
        <Link href="/" className="text-base font-semibold text-accent">Readfirst</Link>
        <LinkButton href="/login" size="sm">Sign in</LinkButton>
      </header>
      <main className="mx-auto w-full max-w-[70rem] flex-1 px-4 tablet:px-6">{children}</main>
      <footer className="mx-auto mt-16 flex w-full max-w-[70rem] flex-wrap gap-4 border-t border-border px-4 py-6 text-muted tablet:px-6">
        <Link href="/compliance" className="hover:text-text">Compliance</Link>
        <Link href="/privacy" className="hover:text-text">Privacy</Link>
        <Link href="/terms" className="hover:text-text">Terms</Link>
      </footer>
    </div>
  )
}
