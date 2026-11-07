import { Check } from 'lucide-react'
import Link from 'next/link'
import { type ComponentProps, type ReactNode, ViewTransition } from 'react'

const join = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ')

const VARIANT = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-text/8 border border-text/15 text-text hover:bg-text/14',
  ghost: 'text-text hover:bg-text/10',
  danger: 'bg-danger text-on-accent hover:opacity-90',
}

export type Variant = keyof typeof VARIANT

export const buttonClass = (variant: Variant = 'secondary', size: 'sm' | 'md' = 'md') =>
  join(
    'inline-flex items-center justify-center gap-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-[background-color,border-color,transform,opacity] duration-300 ease-[cubic-bezier(.32,.72,0,1)] active:scale-[.96]',
    'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    size === 'sm' ? 'h-11 tablet:h-8 px-3' : 'h-11 tablet:h-10 px-4',
    VARIANT[variant],
  )

export function LinkButton({ variant, size, className, ...rest }: ComponentProps<typeof Link> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return <Link {...rest} className={join(buttonClass(variant, size), className)} />
}

const BADGE = {
  neutral: 'bg-accent-soft text-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  hot: 'bg-hot-soft text-hot',
}

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={join('inline-block rounded-sm px-1.5 py-0.5 text-xs font-semibold', BADGE[tone])}>{children}</span>
}

const DOT = { good: 'bg-success', wait: 'bg-border-input', needs: 'bg-warning', broken: 'bg-danger' }

export function StatusLine({ tone, message, children }: { tone: keyof typeof DOT; message: string; children?: ReactNode }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <span aria-hidden className={join('size-2 flex-none rounded-pill', DOT[tone])} />
      <span className="font-medium">{message}</span>
      {children}
    </div>
  )
}

export function Banner({ tone = 'warning', children, action }: { tone?: 'warning' | 'danger'; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={join(
        'flex flex-wrap items-center justify-between gap-3 rounded-sm p-3 font-medium',
        tone === 'warning' ? 'bg-warning-soft text-warning' : 'bg-danger-soft text-danger',
      )}
    >
      <span>{children}</span>
      {action}
    </div>
  )
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="perforated bg-paper px-4 py-10 text-center">
      <p className="text-base font-medium">{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function PageHeader({ title, sub, action, morph }: { title: string; sub?: ReactNode; action?: ReactNode; morph?: string }) {
  const heading = <h1 className="wide wrap-anywhere">{title}</h1>
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {morph ? <ViewTransition name={morph}>{heading}</ViewTransition> : heading}
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </header>
  )
}

export const inputClass =
  'w-full min-h-11 tablet:min-h-10 rounded-md border border-text/10 bg-paper px-2.5 py-1.5 text-base tablet:text-sm text-text placeholder:text-muted disabled:bg-surface disabled:text-muted aria-invalid:border-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

export function Field({ label, name, help, ...rest }: ComponentProps<'input'> & { label: string; name: string; help?: string }) {
  return (
    <div>
      <div className="form-box">
        <label htmlFor={name}>{label}</label>
        <input id={name} name={name} aria-describedby={help ? `${name}-help` : undefined} {...rest} />
      </div>
      {help && <p id={`${name}-help`} className="mt-1 text-xs text-muted">{help}</p>}
    </div>
  )
}

export function TextArea({ label, name, help, mono, ...rest }: ComponentProps<'textarea'> & { label: string; name: string; help?: string; mono?: boolean }) {
  return (
    <div>
      <div className="form-box">
        <label htmlFor={name}>{label}</label>
        <textarea
          id={name}
          name={name}
          aria-describedby={help ? `${name}-help` : undefined}
          className={join('min-h-24 resize-y', mono && 'font-mono')}
          {...rest}
        />
      </div>
      {help && <p id={`${name}-help`} className="mt-1 text-xs text-muted">{help}</p>}
    </div>
  )
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="p-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="wide mt-1 text-xl tabular-nums">{value}</dd>
    </div>
  )
}

export type SetupStep = { label: string; todo: string; done: boolean; href: string; action: string }

/** A strip of numbered stubs. The stub you are on is lit, and it holds the one thing to do next. */
export function SetupStrip({ steps }: { steps: SetupStep[] }) {
  const next = steps.find((s) => !s.done)
  if (!next) return null
  return (
    <section aria-label="Your next step" className="sheet mb-6">
      <ol className="grid grid-cols-2 tablet:grid-cols-4">
        {steps.map((step, i) => (
          <li
            key={step.label}
            aria-current={step === next ? 'step' : undefined}
            className={join('stub relative flex items-center gap-2 px-4 py-3 text-sm font-medium', step === next ? 'lit' : 'text-muted')}
          >
            {step === next && <ViewTransition name="setup-lit"><span aria-hidden className="lit-glow" /></ViewTransition>}
            <span aria-hidden className="relative z-10 tabular-nums">{step.done ? <Check size={16} strokeWidth={2.5} className="text-success" /> : i + 1}</span>
            <span className="relative z-10">{step.label}{step.done && <span className="sr-only"> (done)</span>}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-text/8 p-5">
        <p className="min-w-0 max-w-[60ch] text-base font-medium">{next.todo}</p>
        <LinkButton variant="primary" href={next.href}>{next.action}</LinkButton>
      </div>
    </section>
  )
}

export const money = (micros: number | null) => (micros === null ? '–' : `$${(micros / 1_000_000).toFixed(2)}`)

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function TabLinks({ tabs, active, label = 'Sections' }: { tabs: { href: string; label: string; id: string }[]; active: string; label?: string }) {
  return (
    <nav aria-label={label} className="mb-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-text/6 p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === active ? 'page' : undefined}
          className={join(
            'relative rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-300',
            tab.id === active ? 'text-paper' : 'text-muted hover:text-text',
          )}
        >
          {tab.id === active && <ViewTransition name={`tab-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}><span aria-hidden className="tab-pill" /></ViewTransition>}
          <span className="relative z-10">{tab.label}</span>
        </Link>
      ))}
    </nav>
  )
}
