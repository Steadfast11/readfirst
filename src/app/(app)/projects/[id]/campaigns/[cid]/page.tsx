import Link from 'next/link'
import { ApiButton, ApiForm, AutoRefresh } from '@/components/client'
import { Badge, Banner, buttonClass, Empty, Field, inputClass, money, PageHeader, plural, Stat, StatusLine, TabLinks, TextArea } from '@/components/ui'
import { aiConfigured } from '@/server/ai'
import { campaignAnalytics } from '@/server/analytics'
import { currentUser } from '@/server/auth'
import * as c from '@/server/campaigns'
import { orNotFound } from '@/server/pages'
import { VARIABLES } from '@/server/render'

const STAGE: Record<string, string> = {
  review: 'In review',
  excluded: 'Excluded',
  active: 'Active',
  finished: 'Finished',
  replied: 'Replied',
  bounced: 'Bounced',
  stopped: 'Stopped',
}

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; cid: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { id, cid } = await params
  const tab = (await searchParams).tab ?? 'leads'
  const { orgId } = (await currentUser())!
  const campaign = await orNotFound(c.getCampaign(orgId, cid))
  const state = await c.sendState(orgId, cid)
  const numbers = await campaignAnalytics(orgId, cid)
  const base = `/projects/${id}/campaigns/${cid}`
  const inReview = campaign.status === 'review'
  return (
    <>
      <p className="mb-2"><Link href={`/projects/${id}`} className="text-muted hover:text-text">Back to campaigns</Link></p>
      <PageHeader
        title={campaign.name}
        action={
          <div className="flex gap-2">
            {campaign.status === 'draft' && <ApiButton url={`/api/campaigns/${cid}/start`} variant="primary">Find leads</ApiButton>}
            {campaign.status === 'stopped' ? (
              <ApiButton url={`/api/campaigns/${cid}/start`}>Start again</ApiButton>
            ) : !['archived', 'draft'].includes(campaign.status) ? (
              <ApiButton url={`/api/campaigns/${cid}/stop`}>Stop</ApiButton>
            ) : null}
          </div>
        }
      />
      <StatusLine tone={state.tone} message={state.message} />
      {(state.state === 'preparing' || state.state === 'searching') && <AutoRefresh />}
      {numbers.contacted >= 100 && numbers.replies === 0 && (
        <div className="mt-2">
          <Banner>
            No replies after {numbers.contacted} people. More emails will not fix this. Change who you reach or what you offer before you spend more.
          </Banner>
        </div>
      )}
      <div className="mt-4">
        <TabLinks
          active={tab}
          tabs={[
            { id: 'leads', label: 'Leads', href: base },
            { id: 'targeting', label: 'Targeting', href: `${base}?tab=targeting` },
            { id: 'email', label: 'First email', href: `${base}?tab=email` },
            { id: 'schedule', label: 'Schedule', href: `${base}?tab=schedule` },
            { id: 'sent', label: 'Sent', href: `${base}?tab=sent` },
          ]}
        />
      </div>
      {tab === 'email' ? (
        <EmailTab orgId={orgId} cid={cid} />
      ) : tab === 'targeting' ? (
        <TargetingTab campaign={campaign} />
      ) : tab === 'schedule' ? (
        <ScheduleTab campaign={campaign} />
      ) : tab === 'sent' ? (
        <SentTab orgId={orgId} cid={cid} />
      ) : (
        <LeadsTab orgId={orgId} cid={cid} inReview={inReview} />
      )}
      {inReview && <ApproveBar orgId={orgId} cid={cid} />}
    </>
  )
}

type Campaign = Awaited<ReturnType<typeof c.getCampaign>>

const LANGUAGES = ['auto', 'English', 'Russian', 'Uzbek', 'Spanish', 'German', 'French', 'Portuguese', 'Italian', 'Dutch', 'Polish', 'Turkish', 'Arabic']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hhmm = (minutes: number) => `${String(Math.floor(Math.min(minutes, 1439) / 60)).padStart(2, '0')}:${String(Math.min(minutes, 1439) % 60).padStart(2, '0')}`

function TargetingTab({ campaign: x }: { campaign: Campaign }) {
  return (
    <div className="max-w-lg">
      <ApiForm url={`/api/campaigns/${x.id}`} method="PATCH" submit="Save targeting">
        <Field label="Campaign name" name="name" defaultValue={x.name} required maxLength={160} />
        <TextArea label="What you offer" name="offer" defaultValue={x.offer ?? ''} rows={3} data-keep-empty />
        <TextArea label="The problem it solves" name="customer_problem" defaultValue={x.customerProblem ?? ''} rows={3} data-keep-empty />
        <Field label="Job titles to reach" name="target_role" defaultValue={x.targetRole ?? ''} data-keep-empty />
        <Field label="Countries or regions" name="target_geography" defaultValue={x.targetGeography ?? ''} data-keep-empty />
        <Field label="Company size" name="target_company_size" defaultValue={x.targetCompanySize ?? ''} data-keep-empty help="For example 1-50." />
        <Field label="Search keywords" name="keywords" defaultValue={x.keywords ?? ''} data-keep-empty />
        <TextArea label="A good fit looks like" name="positive_criteria" defaultValue={x.positiveCriteria.join('\n')} rows={3} data-keep-empty help="One per line." />
        <TextArea label="Leave out" name="negative_criteria" defaultValue={x.negativeCriteria.join('\n')} rows={3} data-keep-empty help="One per line." />
        <TextArea label="Example clients" name="example_clients" defaultValue={x.exampleClients.join('\n')} rows={3} data-keep-empty help="One per line." />
        <div>
          <label htmlFor="language" className="mb-1 block text-xs font-semibold">Email language</label>
          <select id="language" name="language" defaultValue={x.language} className={inputClass}>
            {LANGUAGES.map((l) => <option key={l} value={l}>{l === 'auto' ? 'Match the lead' : l}</option>)}
          </select>
        </div>
      </ApiForm>
    </div>
  )
}

function ScheduleTab({ campaign: x }: { campaign: Campaign }) {
  return (
    <div className="max-w-lg">
      <ApiForm url={`/api/campaigns/${x.id}`} method="PATCH" submit="Save schedule">
        <fieldset>
          <legend className="mb-1 font-medium">Send on</legend>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((day, i) => (
              <label key={day} className="flex items-center gap-1.5">
                <input type="checkbox" name="send_days" value={i + 1} data-group defaultChecked={x.sendDays.includes(i + 1)} className="size-4" />
                {day}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" name="send_start" type="time" defaultValue={hhmm(x.sendStartMinute)} required />
          <Field label="Until" name="send_end" type="time" defaultValue={hhmm(x.sendEndMinute)} required />
        </div>
        <p className="text-xs text-muted">In the project’s time zone. You can change it in Settings.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Emails per person" name="max_touches" type="number" min={1} max={6} defaultValue={x.maxTouches} required />
          <Field label="Days between emails" name="followup_delay_days" type="number" min={1} max={30} defaultValue={x.followupDelayDays} required />
        </div>
        <TextArea
          label="Follow-up instructions"
          name="followup_instructions"
          defaultValue={x.followupInstructions}
          rows={3}
          data-keep-empty
          help="What follow-ups should say. The AI writes them. With your own copy and no instructions here, only the first email is sent."
        />
        <TextArea label="Reply instructions" name="reply_instructions" defaultValue={x.replyInstructions} rows={3} data-keep-empty help="Used when auto-replies are on, in Settings." />
      </ApiForm>
    </div>
  )
}

async function SentTab({ orgId, cid }: { orgId: string; cid: string }) {
  const numbers = await campaignAnalytics(orgId, cid)
  const rows = (await c.campaignLeads(orgId, cid)).filter((r) => r.lead.touchesSent > 0)
  return (
    <>
      <dl className="mb-4 grid grid-cols-2 gap-2 tablet:grid-cols-5">
        <Stat label="People contacted" value={numbers.contacted} />
        <Stat label="Replied" value={numbers.replies} />
        <Stat label="Hot" value={numbers.hot} />
        <Stat label="Bounced" value={numbers.bounced} />
        <Stat label="Spend" value={money(numbers.spendMicros)} />
      </dl>
      {numbers.statuses.length > 0 && <p className="mb-4 text-muted">{numbers.statuses.map((s) => `${s.name}: ${s.n}`).join(' · ')}</p>}
      {rows.length === 0 ? (
        <Empty>People you have emailed will appear here.</Empty>
      ) : (
        <>
          <a href={`/api/campaigns/${cid}/export`} download className={buttonClass('secondary', 'sm')}>Export CSV</a>
          <ul className="mt-3 sheet divide-y divide-border">
            {rows.map(({ lead, contact }) => (
              <li key={lead.id} className="flex flex-wrap justify-between gap-2 p-3">
                <span className="min-w-0 wrap-anywhere">{contact.erasedAt ? 'Erased contact' : `${contact.firstName ?? ''} ${contact.lastName ?? ''} · ${contact.email}`}</span>
                <span className="text-muted">{plural(lead.touchesSent, 'email')} · {STAGE[lead.stage]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

async function LeadsTab({ orgId, cid, inReview }: { orgId: string; cid: string; inReview: boolean }) {
  const rows = await c.campaignLeads(orgId, cid)
  if (!rows.length) return <Empty>No one in this campaign yet.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="p-2">Name</th>
            <th scope="col" className="p-2">Company</th>
            <th scope="col" className="hidden p-2 tablet:table-cell">Email</th>
            <th scope="col" className="p-2">Stage</th>
            {inReview && <th scope="col" className="p-2"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ lead, contact }) => (
            <tr key={lead.id} className="border-t border-border hover:bg-surface-hover">
              <td className="p-2 wrap-anywhere">{[contact.firstName, contact.lastName].filter(Boolean).join(' ')}</td>
              <td className="p-2 wrap-anywhere">{contact.companyName}</td>
              <td className="hidden p-2 wrap-anywhere tablet:table-cell">{contact.email}</td>
              <td className="p-2">
                <Badge tone={lead.stage === 'bounced' ? 'danger' : 'neutral'}>{STAGE[lead.stage]}</Badge>
                {contact.emailStatus === 'risky' && <span className="ml-2"><Badge tone="warning">Risky address</Badge></span>}
                {lead.fitScore !== null && <span className="ml-2 text-xs text-muted">Fit {lead.fitScore}/5</span>}
                {lead.fitReason && <span className="block text-xs text-muted wrap-anywhere">{lead.fitReason}</span>}
              </td>
              {inReview && (
                <td className="p-2 text-right">
                  <ApiButton
                    url={`/api/campaigns/${cid}/leads/${lead.id}`}
                    method="PATCH"
                    body={{ stage: lead.stage === 'excluded' ? 'review' : 'excluded' }}
                    size="sm"
                    variant="ghost"
                  >
                    {lead.stage === 'excluded' ? 'Restore' : 'Exclude'}
                  </ApiButton>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

async function EmailTab({ orgId, cid }: { orgId: string; cid: string }) {
  const campaign = await c.getCampaign(orgId, cid)
  const email = await c.resolveFirstEmail(campaign)
  const previews = await c.previewEmails(orgId, cid)
  const ai = email.mode === 'instructions'
  const warnings = ai ? [] : c.emailWarnings(email.subject, email.body)
  const url = `/api/campaigns/${cid}/first-email`
  const locked = campaign.useProjectEmail
  return (
    <div className="grid gap-8 desktop:grid-cols-2">
      <div>
        <div className="mb-4 flex flex-wrap gap-2">
          <ApiButton url={`/api/campaigns/${cid}`} method="PATCH" body={{ use_project_email: !locked }} size="sm" variant="ghost">
            {locked ? 'Use a custom email' : 'Use the project email'}
          </ApiButton>
          {!locked && (
            <ApiButton url={url} method="PATCH" body={{ mode: ai ? 'my_copy' : 'instructions' }} size="sm" variant="ghost">
              {ai ? 'Write my own copy' : 'Let AI write it'}
            </ApiButton>
          )}
        </div>
        {email.autoRevertedAt && <div className="mb-4"><Banner>Your copy bounced too often, so we switched this campaign to AI emails.</Banner></div>}
        {locked ? (
          <p className="text-muted">This campaign follows the project email, set in Settings.</p>
        ) : ai ? (
          <ApiForm url={url} method="PATCH" submit="Save instructions">
            <TextArea
              label="Instructions"
              name="instructions"
              rows={8}
              defaultValue={email.instructions}
              required
              help="What should the email say? The AI writes one for each lead, using your offer and what it learns about their company."
            />
          </ApiForm>
        ) : (
          <ApiForm url={url} method="PATCH" submit="Save email">
            <Field label="Subject" name="subject" defaultValue={email.subject} required maxLength={200} data-keep-empty />
            <TextArea
              label="Email"
              name="body"
              mono
              rows={10}
              defaultValue={email.body}
              required
              data-keep-empty
              help={`You can use ${VARIABLES.map((v) => `{{${v}}}`).join(', ')}. For a fallback: {{first_name|there}}. For variations: {Hi|Hello}. For a line the AI writes per lead: {{ai: mention their city}}. Your sign-off, address and unsubscribe link are added for you.`}
            />
          </ApiForm>
        )}
        {warnings.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-warning">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
      </div>
      <div>
        <h2 className="mb-3 text-lg">What leads get</h2>
        {c.needsAi(email) && aiConfigured() && (
          <div className="mb-3"><ApiButton url={`/api/campaigns/${cid}/preview`}>{previews.length ? 'Write new samples' : 'Write sample emails'}</ApiButton></div>
        )}
        {previews.length === 0 ? (
          <Empty>{c.needsAi(email) ? 'Samples appear here. Read them before you approve.' : 'Add leads to see a preview.'}</Empty>
        ) : (
          <div className="space-y-3">
            {previews.map((p) => (
              <article key={p.to} aria-label={`Preview for ${p.to}`} className="rounded-md border border-border p-3">
                <p className="text-xs text-muted wrap-anywhere">To {p.to}</p>
                <p className="mt-1 font-medium wrap-anywhere">{p.subject || 'No subject yet'}</p>
                <p className="mt-2 whitespace-pre-wrap wrap-anywhere">{p.body}</p>
                {p.missing.length > 0 && <p className="mt-2 text-warning">No value for {p.missing.join(', ')}. This email would not send.</p>}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

async function ApproveBar({ orgId, cid }: { orgId: string; cid: string }) {
  const { blockers, leads, mailboxes, unsendable, unverified } = await c.approvalBlockers(orgId, cid)
  return (
    <div className="sticky bottom-14 mt-6 border-t border-border bg-bg py-3 tablet:bottom-0">
      {blockers.length > 0 ? (
        <Banner>Before you can approve: {blockers[0]}</Banner>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {plural(leads, 'lead')} ready
            {unsendable > 0 && <span className="block text-warning">{plural(unsendable, 'lead')} missing a value this email needs. They will not be sent.</span>}
            {unverified > 0 && <span className="block text-muted">Addresses are not verified, so expect some bounces.</span>}
          </span>
          <ApiButton
            url={`/api/campaigns/${cid}/approve`}
            variant="primary"
            confirm={`Email ${plural(leads, 'person', 'people')} from ${plural(mailboxes, 'mailbox', 'mailboxes')}? Sending starts in the next send window.`}
            confirmLabel="Approve and send"
          >
            Approve {plural(leads, 'lead')}
          </ApiButton>
        </div>
      )}
    </div>
  )
}
