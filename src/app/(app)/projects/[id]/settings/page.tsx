import { ApiButton, ApiForm } from '@/components/client'
import { ProjectTabs } from '@/components/project'
import { Field, money, PageHeader, TextArea } from '@/components/ui'
import { spendByDay } from '@/server/analytics'
import { getProjectEmail } from '@/server/campaigns'
import { currentUser } from '@/server/auth'
import { getProject, listStatuses } from '@/server/projects'
import { spentThisMonth, spentToday } from '@/server/spend'

const KIND: Record<string, string> = { ai: 'AI', lead_data: 'Lead data', email_verification: 'Email checks', mailbox: 'Mailboxes' }

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { orgId } = (await currentUser())!
  const project = await getProject(orgId, id)
  const dailyMost = Number(project.dailyBudgetMicros) * 31
  const most = project.monthlyCapMicros === null ? dailyMost : Math.min(dailyMost, Number(project.monthlyCapMicros))
  const [today, month, statuses, email, spend] = await Promise.all([
    spentToday(project),
    spentThisMonth(project),
    listStatuses(orgId, id),
    getProjectEmail(orgId, id),
    spendByDay(orgId, id),
  ])
  return (
    <>
      <PageHeader morph={`project-${id}`} title={project.domain ?? 'Project'} />
      <ProjectTabs id={id} active="settings" />
      <div className="max-w-lg">
        <ApiForm url={`/api/projects/${id}`} method="PATCH" submit="Save settings">
          <Field label="Sender name" name="sender_name" defaultValue={project.senderName} data-keep-empty help="Shown as the From name and at the end of each email." />
          <Field label="Time zone" name="timezone" defaultValue={project.timezone} required help="Used for send windows. For example Asia/Tashkent." />
          <TextArea
            label="Business name and postal address"
            name="legal_footer"
            defaultValue={project.legalFooter}
            data-keep-empty
            help="Added to the bottom of every first email and follow-up."
          />
          <label className="flex items-start gap-2">
            <input type="checkbox" name="legal_basis_confirmed" defaultChecked={Boolean(project.legalBasisConfirmedAt)} className="mt-0.5 size-4" />
            <span>I have a lawful reason to email the people I import, and I will honour opt-outs.</span>
          </label>
          <TextArea
            label="What the AI may say about you"
            name="facts"
            defaultValue={project.facts}
            rows={5}
            data-keep-empty
            help="Your offer, proof and limits. The AI treats nothing else about you as true."
          />
          <h2 className="pt-4 text-lg">Spending</h2>
          <Field
            label="Daily budget in dollars"
            name="daily_budget"
            type="number"
            min={0}
            max={300}
            step="0.5"
            defaultValue={Number(project.dailyBudgetMicros) / 1_000_000}
            required
            help={`Per day, not a total. Covers AI, lead data and email checks. Zero pauses everything. At this limit the most you can spend in a month is ${money(most)}. Spent today: ${money(today)}.`}
          />
          <Field
            label="Monthly cap in dollars"
            name="monthly_cap"
            type="number"
            min={0}
            step="1"
            defaultValue={project.monthlyCapMicros === null ? '' : Number(project.monthlyCapMicros) / 1_000_000}
            data-null-empty
            help={`Optional. Spent this month: $${(month / 1_000_000).toFixed(2)}.`}
          />
          <h2 className="pt-4 text-lg">Auto-replies</h2>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="auto_reply_enabled" defaultChecked={project.autoReplyEnabled} className="mt-0.5 size-4" />
            <span>Let the AI answer interested people for me. It waits first, so you can check or cancel each reply.</span>
          </label>
          <Field label="Wait before sending, in minutes" name="auto_reply_delay_minutes" type="number" min={5} max={1440} defaultValue={project.autoReplyDelayMinutes} required />
          <Field label="Booking link" name="booking_url" type="url" defaultValue={project.bookingUrl ?? ''} data-keep-empty help="Sent to people who want to talk. It is the only link an auto-reply may contain." />
        </ApiForm>
        <h2 className="mt-8 mb-3 text-lg">Lead statuses</h2>
        <ul className="mb-3 sheet divide-y divide-border">
          {statuses.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 p-2">
              <span className="wrap-anywhere">{s.name}</span>
              <ApiButton url={`/api/statuses/${s.id}`} method="DELETE" size="sm" variant="ghost">Remove</ApiButton>
            </li>
          ))}
        </ul>
        <ApiForm url={`/api/projects/${id}/statuses`} submit="Add status" reset>
          <Field label="New status" name="name" required maxLength={40} />
        </ApiForm>
        <h2 className="mt-8 mb-3 text-lg">Project email</h2>
        <p className="mb-3 text-muted">Campaigns can follow this email instead of having their own.</p>
        <ApiForm url={`/api/projects/${id}/first-email`} method="PATCH" submit="Save project email" extra={{ mode: 'my_copy' }}>
          <Field label="Default subject" name="subject" defaultValue={email.subject} maxLength={200} data-keep-empty />
          <TextArea label="Default email" name="body" mono rows={6} defaultValue={email.body} data-keep-empty />
        </ApiForm>
        <h2 className="mt-8 mb-3 text-lg">Spend by day</h2>
        {spend.length === 0 ? (
          <p className="text-muted">Nothing spent in the last two weeks.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead><tr className="text-left text-xs text-muted"><th scope="col" className="p-2">Day</th><th scope="col" className="p-2">Kind</th><th scope="col" className="p-2 text-right">Amount</th></tr></thead>
            <tbody>
              {spend.map((r) => (
                <tr key={`${r.day}${r.kind}`} className="border-t border-border">
                  <td className="p-2">{r.day}</td>
                  <td className="p-2">{KIND[r.kind] ?? r.kind}</td>
                  <td className="p-2 text-right">{money(r.micros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
