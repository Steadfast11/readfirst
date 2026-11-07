import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/client'
import { currentUser, devLoginEnabled, googleEnabled } from '@/server/auth'

export default async function LoginPage() {
  if (await currentUser()) redirect('/projects')
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-xl">Sign in</h1>
      <p className="mb-6 text-muted">Your outreach, your mailboxes.</p>
      <LoginForm dev={devLoginEnabled} google={googleEnabled} />
    </main>
  )
}
