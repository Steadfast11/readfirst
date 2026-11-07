'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { signIn, signOut } from 'next-auth/react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, ViewTransition, type ReactNode } from 'react'
import { buttonClass, Field, inputClass, type Variant } from './ui'

/** False until the page's script runs. A form must not submit before then, or the browser would put its fields in the URL. */
function useReady() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return ready
}

/** A main navigation link that knows when you are in its section. */
export function NavLink({ href, label, className, pill, children }: { href: string; label: string; className: string; pill: string; children: ReactNode }) {
  const active = usePathname().startsWith(href)
  return (
    <Link href={href} aria-label={label} title={label} aria-current={active ? 'page' : undefined} className={`nav-link ${className}`}>
      {active && <ViewTransition name={pill}><span aria-hidden className="nav-pill" /></ViewTransition>}
      {children}
    </Link>
  )
}

/** A command to paste into another program, with a button that copies it. */
export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{label}</span>
        <button
          type="button"
          className={buttonClass('ghost', 'sm')}
          onClick={async () => {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-xs whitespace-pre">{text}</pre>
    </div>
  )
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.message ?? 'Something went wrong. Try again.')
  return data
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-sm text-danger">{error}</p> : null
}

/** A form that posts JSON (or files) to an API route, then refreshes or moves on. */
export function ApiForm({
  url,
  method = 'POST',
  submit,
  extra,
  redirectTo,
  multipart,
  reset,
  children,
  onDone,
}: {
  url: string
  method?: string
  submit: string
  extra?: Record<string, unknown>
  redirectTo?: string
  multipart?: boolean
  reset?: boolean
  children: ReactNode
  onDone?: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const ready = useReady()

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const raw = new FormData(form)
      let body: unknown = raw
      if (!multipart) {
        const values: Record<string, unknown> = {}
        const put = (name: string, value: unknown) => {
          const [head, tail] = name.split('.')
          if (tail) values[head] = { ...(values[head] as object), [tail]: value }
          else values[name] = value
        }
        for (const el of Array.from(form.elements) as HTMLInputElement[]) {
          if (!el.name) continue
          if (el.dataset.group !== undefined) {
            values[el.name] = [...((values[el.name] as number[]) ?? []), ...(el.checked ? [Number(el.value)] : [])]
          } else if (el.type === 'checkbox') put(el.name, el.checked)
          else if (el.value !== '') put(el.name, el.value)
          else if (el.dataset.keepEmpty) put(el.name, '')
          else if (el.dataset.nullEmpty) put(el.name, null)
        }
        body = { ...values, ...extra }
      } else {
        for (const [k, v] of Object.entries(extra ?? {})) raw.set(k, String(v))
      }
      const data = await send(url, method, body)
      if (reset) form.reset()
      onDone?.()
      if (redirectTo) router.push(redirectTo.replace(':id', data?.id ?? ''))
      else {
        setSaved(true)
        router.refresh()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {children}
      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || !ready} aria-busy={busy} className={buttonClass('primary')}>{submit}</button>
        {saved && !redirectTo && <span role="status" className="text-sm text-muted">Saved</span>}
      </div>
    </form>
  )
}

/** One click on an API route. With confirm, it says exactly what will happen first. */
export function ApiButton({
  url,
  method = 'POST',
  body,
  children,
  variant,
  size,
  confirm,
  confirmLabel,
  redirectTo,
}: {
  url: string
  method?: string
  body?: unknown
  children: ReactNode
  variant?: Variant
  size?: 'sm' | 'md'
  confirm?: string
  confirmLabel?: string
  redirectTo?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const data = await send(url, method, body)
      setOpen(false)
      if (redirectTo) router.push(redirectTo.replace(':id', data?.id ?? ''))
      else router.refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!confirm) {
    return (
      <span className="inline-flex flex-col gap-1">
        <button type="button" disabled={busy} aria-busy={busy} onClick={run} className={buttonClass(variant, size)}>{children}</button>
        <ErrorText error={error} />
      </span>
    )
  }
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={confirmLabel ?? 'Are you sure?'}
      trigger={<button type="button" className={buttonClass(variant, size)}>{children}</button>}
    >
      <p>{confirm}</p>
      <ErrorText error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Dialog.Close className={buttonClass('ghost')}>Cancel</Dialog.Close>
        <button type="button" disabled={busy} aria-busy={busy} onClick={run} className={buttonClass(variant === 'danger' ? 'danger' : 'primary')}>
          {confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </Modal>
  )
}

export function Modal({
  title,
  trigger,
  children,
  open,
  onOpenChange,
}: {
  title: string
  trigger: ReactNode
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="dialog-pop fixed inset-0 overflow-y-auto bg-paper p-6 tablet:inset-auto tablet:top-1/2 tablet:left-1/2 tablet:w-full tablet:max-w-md tablet:-translate-x-1/2 tablet:-translate-y-1/2 tablet:rounded-lg tablet:shadow-pop"
        >
          <Dialog.Title className="mb-3 text-lg">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function NewProject() {
  const [open, setOpen] = useState(false)
  const [noSite, setNoSite] = useState(false)
  const field = 'w-full min-h-11 rounded-md border border-border-input px-2.5'
  return (
    <Modal open={open} onOpenChange={setOpen} title="New project" trigger={<button type="button" className={buttonClass('primary')}>New project</button>}>
      <ApiForm url="/api/projects" submit="Create project" redirectTo="/projects/:id">
        {noSite ? (
          <>
            <div>
              <label htmlFor="business" className="mb-1 block text-xs font-semibold">What do you sell?</label>
              <textarea id="business" name="no_website.business" required minLength={3} rows={3} className={`${field} py-1.5`} />
            </div>
            <div>
              <label htmlFor="customer" className="mb-1 block text-xs font-semibold">Who is your ideal customer?</label>
              <input id="customer" name="no_website.customer" className={field} />
            </div>
            <div>
              <label htmlFor="geo" className="mb-1 block text-xs font-semibold">Which markets?</label>
              <input id="geo" name="no_website.geo" className={field} />
            </div>
          </>
        ) : (
          <div>
            <label htmlFor="domain" className="mb-1 block text-xs font-semibold">Your website</label>
            <input id="domain" name="domain" required placeholder="yourcompany.com" className={field} />
          </div>
        )}
      </ApiForm>
      <button type="button" onClick={() => setNoSite(!noSite)} className="mt-3 text-sm text-muted underline underline-offset-2">
        {noSite ? 'I have a website' : 'I don’t have a website'}
      </button>
    </Modal>
  )
}

export function NewCampaign({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Modal open={open} onOpenChange={setOpen} title="New campaign" trigger={<button type="button" className={buttonClass('secondary')}>New campaign</button>}>
      <ApiForm url="/api/campaigns" submit="Create campaign" extra={{ project_id: projectId }} redirectTo={`/projects/${projectId}/campaigns/:id?tab=targeting`}>
        <div>
          <label htmlFor="name" className="mb-1 block text-xs font-semibold">Who do you want to reach?</label>
          <input id="name" name="name" required maxLength={160} placeholder="Dental clinics in Portugal" className="w-full min-h-11 rounded-md border border-border-input px-2.5" />
          <p className="mt-1 text-xs text-muted">The AI drafts the rest. You can change all of it.</p>
        </div>
      </ApiForm>
    </Modal>
  )
}

/** Reloads the page every few seconds while something is still working. */
export function AutoRefresh({ seconds = 2 }: { seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000)
    return () => clearInterval(id)
  }, [seconds, router])
  return null
}

export function LoginForm({ dev, google }: { dev: boolean; google: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const ready = useReady()
  async function devLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const email = String(new FormData(e.currentTarget).get('email'))
    const res = await signIn('dev', { email, redirect: false })
    if (res?.ok) window.location.href = '/projects'
    else setError('We could not sign you in.')
  }
  return (
    <div className="space-y-4">
      {google && (
        <button type="button" onClick={() => signIn('google', { callbackUrl: '/projects' })} className={`${buttonClass('primary')} w-full`}>
          Continue with Google
        </button>
      )}
      {dev && (
        <form onSubmit={devLogin} className="space-y-3">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-semibold">Local test email</label>
            <input id="email" name="email" type="email" required className="w-full min-h-11 rounded-md border border-border-input px-2.5" />
            <p className="mt-1 text-xs text-muted">Only available on your own machine.</p>
          </div>
          <ErrorText error={error} />
          <button type="submit" disabled={!ready} className={`${buttonClass('secondary')} w-full`}>Sign in</button>
        </form>
      )}
      {!dev && !google && <p>Sign-in is not set up yet. Add Google credentials to the environment.</p>}
    </div>
  )
}

export function SignOut() {
  return <button type="button" onClick={() => signOut({ callbackUrl: '/login' })} className={buttonClass('ghost', 'sm')}>Sign out</button>
}

const PRESETS = {
  custom: { label: 'Other', smtp: '', imap: '', smtpPort: 587 },
  google: { label: 'Google Workspace', smtp: 'smtp.gmail.com', imap: 'imap.gmail.com', smtpPort: 587 },
  microsoft: { label: 'Microsoft 365', smtp: 'smtp.office365.com', imap: 'outlook.office365.com', smtpPort: 587 },
  zoho: { label: 'Zoho Mail', smtp: 'smtp.zoho.com', imap: 'imap.zoho.com', smtpPort: 587 },
}

/** Picks the server settings for common providers, so most people type only an address and a password. */
export function MailServerFields() {
  const [choice, setChoice] = useState<keyof typeof PRESETS>('custom')
  const p = PRESETS[choice]
  return (
    <>
      <div>
        <label htmlFor="provider" className="mb-1 block text-xs font-semibold">Mail provider</label>
        <select id="provider" value={choice} onChange={(e) => setChoice(e.target.value as keyof typeof PRESETS)} className={inputClass}>
          {Object.entries(PRESETS).map(([id, x]) => <option key={id} value={id}>{x.label}</option>)}
        </select>
        {choice === 'microsoft' && <p className="mt-1 text-xs text-muted">Microsoft has been retiring password sign-in for mail. Your admin may need to allow it.</p>}
      </div>
      <div key={choice} className="space-y-4">
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="SMTP host" name="smtp_host" defaultValue={p.smtp} required />
          <Field label="Port" name="smtp_port" inputMode="numeric" defaultValue={p.smtpPort} required />
        </div>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="IMAP host" name="imap_host" defaultValue={p.imap} required />
          <Field label="Port" name="imap_port" inputMode="numeric" defaultValue={993} required />
        </div>
      </div>
    </>
  )
}

export function DeleteAccount() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run() {
    try {
      await send('/api/account', 'DELETE')
      await signOut({ callbackUrl: '/' })
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <Modal open={open} onOpenChange={setOpen} title="Delete account" trigger={<button type="button" className={buttonClass('ghost', 'sm')}>Delete account</button>}>
      <p>This deletes every project, lead, email and mailbox setting, and cannot be undone. Queued emails will not send.</p>
      <ErrorText error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Dialog.Close className={buttonClass('ghost')}>Cancel</Dialog.Close>
        <button type="button" onClick={run} className={buttonClass('danger')}>Delete everything</button>
      </div>
    </Modal>
  )
}

export function ImportProgress({ url, done }: { url: string; done: boolean }) {
  const router = useRouter()
  useEffect(() => {
    if (done) return
    const id = setInterval(async () => {
      const state = await send(url, 'GET').catch(() => null)
      if (state?.status !== 'pending') router.refresh()
    }, 1500)
    return () => clearInterval(id)
  }, [url, done, router])
  return null
}
