import { and, eq, sql } from 'drizzle-orm'
import { db, t } from '@/db'
import { aiConfigured } from './ai'
import { checkMailboxDns } from './projects'

const MIN_SENT = 20
const MAILBOX_BOUNCE_LIMIT = 0.05
const COPY_BOUNCE_LIMIT = 0.1

/** Too many bounces hurt a domain's name, so the mailbox stops until you look at it. */
async function pauseBouncingMailboxes() {
  const { rows } = await db.execute<{ id: string; sent: number; bounced: number }>(sql`
    select b.id,
      count(*) filter (where m.direction = 'outbound' and m.status = 'sent')::int as sent,
      count(*) filter (where m.kind = 'bounce')::int as bounced
    from mailboxes b join messages m on m.mailbox_id = b.id
    where b.status = 'active' and coalesce(m.sent_at, m.received_at) > now() - interval '7 days'
    group by b.id`)
  for (const r of rows) {
    if (r.sent < MIN_SENT || r.bounced / r.sent < MAILBOX_BOUNCE_LIMIT) continue
    await db
      .update(t.mailboxes)
      .set({ status: 'paused', statusReason: `Paused: ${r.bounced} of ${r.sent} emails bounced this week. Clean your list, then test the mailbox again.` })
      .where(eq(t.mailboxes.id, r.id))
  }
}

/** Your own copy going to bad addresses switches to AI, or stops if there is no AI. */
async function revertBouncingCopy() {
  const { rows } = await db.execute<{ id: string; org_id: string; sent: number; bounced: number }>(sql`
    select c.id, c.org_id,
      count(*) filter (where m.kind in ('first','followup') and m.status = 'sent')::int as sent,
      count(*) filter (where m.kind = 'bounce')::int as bounced
    from campaigns c
    join first_emails f on f.campaign_id = c.id and f.mode = 'my_copy' and f.auto_reverted_at is null
    join leads l on l.campaign_id = c.id join messages m on m.lead_id = l.id
    where c.status = 'sending' group by c.id`)
  for (const r of rows) {
    if (r.sent < MIN_SENT || r.bounced / r.sent < COPY_BOUNCE_LIMIT) continue
    await db.transaction(async (tx) => {
      if (aiConfigured()) {
        await tx
          .update(t.firstEmails)
          .set({ mode: 'instructions', autoRevertedAt: sql`now()`, instructions: sql`case when instructions = '' then 'Write a short, plain first email about the offer.' else instructions end` })
          .where(eq(t.firstEmails.campaignId, r.id))
        await tx.execute(sql`
          update messages m set needs_draft = true from leads l
          where l.id = m.lead_id and l.campaign_id = ${r.id} and m.status = 'queued' and m.kind = 'first'`)
      } else {
        await tx.update(t.firstEmails).set({ autoRevertedAt: sql`now()` }).where(eq(t.firstEmails.campaignId, r.id))
        await tx.update(t.campaigns).set({ status: 'stopped', statusBeforeStop: 'sending' }).where(eq(t.campaigns.id, r.id))
      }
      await tx.insert(t.auditEvents).values({
        orgId: r.org_id,
        actor: 'system',
        action: 'campaign.copy_reverted',
        subjectType: 'campaign',
        subjectId: r.id,
        detail: { sent: r.sent, bounced: r.bounced },
      })
    })
  }
}

export async function protectSending() {
  await pauseBouncingMailboxes()
  await revertBouncingCopy()
}

/** Hourly. Records fall out of DNS more often than people expect. */
export async function recheckDns() {
  const boxes = await db.select({ id: t.mailboxes.id, orgId: t.mailboxes.orgId }).from(t.mailboxes).where(and(eq(t.mailboxes.status, 'active')))
  for (const box of boxes) await checkMailboxDns(box.orgId, box.id).catch(() => {})
}
