import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource-variable/inter/index.css'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import './base.css'

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
  title: { default: 'Readfirst', template: '%s · Readfirst' },
  description: 'Cold email that waits for your OK. Nothing sends until you have read it.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg font-sans text-sm text-text antialiased">{children}</body>
    </html>
  )
}
