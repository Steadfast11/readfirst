import Link from 'next/link'
import { ApiButton, ApiForm } from '@/components/client'
import { ProjectTabs } from '@/components/project'
import { Badge, Banner, Empty, inputClass, PageHeader, TabLinks, TextArea } from '@/components/ui'
import { currentUser } from '@/server/auth'
import { getThread, listConversations, type InboxTab } from '@/server/inbox'
import { isUuid, orNull } from '@/server/pages'
import { getProject } from '@/server/projects'

const EMPTY: Record<InboxTab, string> = {
  need_reply: 'Nothing needs you right now.',
  hot: 'Interested people will appear here.',
  quiet: 'Hot leads who stop replying for three days appear here.',
  replied: 'Replies will appear here.',
  sent: 'People you have emailed will appear here.',
}

const INTENT: Record<string, string> = {
  interested: 'Interested',
  meeting_request: 'Wants a meeting',
  question: 'Question',
  referral: 'Referral',
  not_now: 'Not now',
  not_interested: 'Not interested',
  unsubscribe: 'Unsubscribe',
  other: 'Other',
}

const whenIn = (timeZone: string) => (value: string | null) =>
  value ? new Date(value).toLocaleString('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; lead?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const tab = (['need_reply', 'hot', 'quiet', 'replied', 'sent'].includes(query.tab ?? '') ? query.tab : 'need_reply') as InboxTab
  const { orgId } = (await currentUser())!
  const project = await getProject(orgId, id)
  const rows = await listConversations(orgId, id, tab)
  const base = `/projects/${id}/inbox`
  const when = whenIn(project.timezone)
  const open = query.lead && isUuid(query.lead) ? query.lead : undefined
  return (
    <>
      <PageHeader morph={`project-${id}`} title={project.domain ?? 'Project'} />
      <ProjectTabs id={id} active="inbox" />
      <div className="tablet:grid tablet:grid-cols-[18rem_1fr] tablet:gap-6 desktop:grid-cols-[21rem_1fr]">
        <section aria-label="Conversations" className={open ? 'hidden tablet:block' : ''}>
          <TabLinks
            label="Inbox filters"
            active={tab}
            tabs={[
              { id: 'need_reply', label: 'Need reply', href: `${base}?tab=need_reply` },
              { id: 'hot', label: 'Hot', href: `${base}?tab=hot` },
              { id: 'quiet', label: 'Gone quiet', href: `${base}?tab=quiet` },
              { id: 'replied', label: 'Replied', href: `${base}?tab=replied` },
              { id: 'sent', label: 'Sent', href: `${base}?tab=sent` },
            ]}
          />
          {rows.length === 0 ? (
            <Empty>{EMPTY[tab]}</Empty>
          ) : (
            <ul className="sheet divide-y divide-border">
              {rows.map((r) => (
                <li key={r.leadId}>
                  <Link
                    href={`${base}?tab=${tab}&lead=${r.leadId}`}
                    aria-current={open === r.leadId ? 'true' : undefined}
                    className={`block p-3 hover:bg-surface-hover ${open === r.leadId ? 'bg-accent-soft' : ''}`}
                  >
                    <span className="flex justify-between gap-2">
                      <span className={r.needsReply ? 'font-semibold' : 'font-medium'}>
                        {r.erasedAt ? 'Erased contact' : [r.firstName, r.lastName].filter(Boolean).join(' ')}
                        {r.needsReply && <span className="sr-only"> needs a reply</span>}
                      </span>
                      <span className="text-xs whitespace-nowrap text-muted">{when(r.lastMessageAt)}</span>
                    </span>
                    {r.company && <span className="block text-muted">{r.company}</span>}
                    {r.hot && <span className="block"><Badge tone="hot">Hot</Badge></span>}
                    <span className="block truncate text-muted">{r.snippet}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        {open ? (
          <Thread orgId={orgId} leadId={open} back={`${base}?tab=${tab}`} timeZone={project.timezone} />
        ) : (
          <p className="hidden pt-12 text-center text-muted tablet:block">Pick a conversation to read it.</p>
        )}
      </div>
    </>
  )
}

async function Thread({ orgId, leadId, back, timeZone }: { orgId: string; leadId: string; back: string; timeZone: string }) {
  const when = whenIn(timeZone)
  const thread = await orNull(getThread(orgId, leadId))
  if (!thread) return <p className="pt-12 text-center text-muted">We could not find this conversation.</p>
  const { lead, contact, messages, statuses, replyBlockedReason } = thread
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  return (
    <section aria-label={`Conversation with ${name}`} className="min-w-0">
      <p className="mb-3 tablet:hidden"><Link href={back} className="text-muted">Back to inbox</Link></p>
      <div className="grid gap-6 desktop:grid-cols-[1fr_16rem]">
        <div className="min-w-0 space-y-3">
          {messages.map((m) => (
            <article key={m.id} className={`rounded-md border p-3 ${m.direction === 'outbound' ? 'border-surface bg-surface' : 'border-border'}`}>
              <header className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
                <span>{m.direction === 'outbound' ? `You to ${name}` : name}</span>
                <span>
                  {m.status === 'queued' && m.kind !== 'auto_reply' && <Badge>Queued</Badge>}
                  {m.kind === 'auto_reply' && <Badge>AI reply</Badge>}
                  {m.intent && <Badge tone={m.intent === 'interested' || m.intent === 'meeting_request' ? 'hot' : 'neutral'}>{INTENT[m.intent]}</Badge>}
                  {(m.status === 'failed' || m.status === 'cancelled') && <Badge tone="danger">Not sent</Badge>}
                  {m.status === 'unknown' && <Badge tone="warning">Result unknown</Badge>}
                  {m.kind === 'bounce' && <Badge tone="danger">Bounced</Badge>}
                  {m.kind === 'auto_response' && <Badge>Auto-response</Badge>}{' '}
                  {when(m.sentAt ?? m.receivedAt)}
                </span>
              </header>
              {m.subject && <p className="mb-1 font-medium wrap-anywhere">{m.subject}</p>}
              {m.statusReason && m.status !== 'sent' && <p className="mb-1 text-warning">{m.statusReason}</p>}
              <p className="whitespace-pre-wrap wrap-anywhere">{m.erasedAt ? 'Removed.' : m.bodyText}</p>
              {m.translation && <p className="mt-2 border-l-2 border-border pl-2 whitespace-pre-wrap wrap-anywhere text-muted">{m.translation}</p>}
              {m.kind === 'reply' && !m.translation && !m.erasedAt && (
                <div className="mt-2"><ApiButton url={`/api/messages/${m.id}/translate`} size="sm" variant="ghost">Translate</ApiButton></div>
              )}
              {m.intentReason && (
                <p className="mt-2 text-xs text-muted">
                  {m.intentReason} Confidence {Math.round(Number(m.intentConfidence) * 100)}%.
                </p>
              )}
              {m.kind === 'auto_reply' && m.status === 'queued' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">Sends at {when(m.sendAfter)}</span>
                  <ApiButton url={`/api/messages/${m.id}/send-now`} size="sm">Send now</ApiButton>
                  <ApiButton url={`/api/messages/${m.id}/cancel`} size="sm" variant="ghost">Cancel</ApiButton>
                </div>
              )}
            </article>
          ))}
          {replyBlockedReason ? (
            <Banner>{replyBlockedReason}</Banner>
          ) : (
            <ApiForm url={`/api/leads/${leadId}/reply`} submit="Send reply" reset>
              <TextArea label="Reply" name="body" required rows={5} />
            </ApiForm>
          )}
          {lead.needsReply && (
            <ApiButton url={`/api/leads/${leadId}/mark-replied`} variant="ghost" size="sm">I answered outside this app</ApiButton>
          )}
        </div>
        <aside aria-label="Lead details" className="h-fit space-y-3 rounded-md bg-surface p-3">
          <div>
            <p className="font-semibold wrap-anywhere">{name}</p>
            <p className="text-muted wrap-anywhere">{[contact.jobTitle, contact.companyName].filter(Boolean).join(', ')}</p>
            <p className="text-muted wrap-anywhere">{contact.email}</p>
          </div>
          {lead.whyHot && <p><Badge tone="hot">Hot</Badge> <span className="wrap-anywhere">{lead.whyHot}</span></p>}
          <ApiForm url={`/api/leads/${leadId}`} method="PATCH" submit="Save">
            {lead.stage === 'replied' && (
              <div>
                <label htmlFor="status_id" className="mb-1 block text-xs font-semibold">Status</label>
                <select id="status_id" name="status_id" data-null-empty defaultValue={lead.statusId ?? ''} className={inputClass}>
                  <option value="">No status</option>
                  {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            <TextArea label="Note" name="note" defaultValue={lead.note ?? ''} data-keep-empty rows={3} />
          </ApiForm>
          {!contact.erasedAt && (
            <ApiButton
              url={`/api/contacts/${contact.id}/erase`}
              size="sm"
              variant="danger"
              confirm={`Erase ${name} and every email to or from them? This cannot be undone. A hash stays so they are never contacted again.`}
              confirmLabel="Erase person"
            >
              Erase person
            </ApiButton>
          )}
        </aside>
      </div>
    </section>
  )
}
