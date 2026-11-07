import { and, asc, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, t, type Db } from '@/db'
import { ApiError, notFound } from './http'
import { getProject } from './projects'
import { hasValues } from './render'
import { isSuppressed } from './suppression'

export const replyBody = z.strictObject({ body: z.string().trim().min(1).max(10000) })
export const leadUpdate = z.strictObject({
  status_id: z.uuid().nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
})

export type InboxTab = 'need_reply' | 'hot' | 'quiet' | 'replied' | 'sent'

export async function listConversations(orgId: string, projectId: string, tab: InboxTab, page = 0) {
  await getProject(orgId, projectId)
  const filter =
    tab === 'need_reply'
      ? eq(t.leads.needsReply, true)
      : tab === 'hot'
        ? isNotNull(t.leads.becameHotAt)
      : tab === 'quiet'
        ? sql`${t.leads.becameHotAt} is not null and ${t.leads.needsReply} = false and ${t.leads.lastMessageAt} < now() - interval '3 days'
            and (select m.direction from messages m where m.lead_id = ${t.leads.id} and m.status in ('sent','received')
                 order by coalesce(m.received_at, m.sent_at) desc limit 1) = 'outbound'`
      : tab === 'replied'
        ? sql`exists (select 1 from messages r where r.lead_id = ${t.leads.id} and r.kind = 'reply')`
        : gt(t.leads.touchesSent, 0)
  return db
    .select({
      leadId: t.leads.id,
      stage: t.leads.stage,
      needsReply: t.leads.needsReply,
      whyHot: t.leads.whyHot,
      hot: sql<boolean>`${t.leads.becameHotAt} is not null`,
      lastMessageAt: t.leads.lastMessageAt,
      firstName: t.contacts.firstName,
      lastName: t.contacts.lastName,
      company: t.contacts.companyName,
      email: t.contacts.email,
      erasedAt: t.contacts.erasedAt,
      snippet: sql<string | null>`(
        select left(m.body_text, 120) from messages m
        where m.lead_id = ${t.leads.id} and m.status in ('sent','received')
        order by coalesce(m.received_at, m.sent_at) desc limit 1)`,
    })
    .from(t.leads)
    .innerJoin(t.contacts, eq(t.contacts.id, t.leads.contactId))
    .innerJoin(t.campaigns, eq(t.campaigns.id, t.leads.campaignId))
    .where(and(eq(t.leads.orgId, orgId), eq(t.campaigns.projectId, projectId), filter))
    .orderBy(sql`${t.leads.lastMessageAt} desc nulls last`)
    .limit(50)
    .offset(page * 50)
}

async function ownedLead(orgId: string, id: string) {
  const [row] = await db
    .select({ lead: t.leads, contact: t.contacts, campaign: t.campaigns })
    .from(t.leads)
    .innerJoin(t.contacts, eq(t.contacts.id, t.leads.contactId))
    .innerJoin(t.campaigns, eq(t.campaigns.id, t.leads.campaignId))
    .where(and(eq(t.leads.orgId, orgId), eq(t.leads.id, id)))
  if (!row) throw notFound('Conversation')
  return row
}

async function replyBlocked(orgId: string, contact: typeof t.contacts.$inferSelect) {
  if (contact.erasedAt || !contact.email) return 'This person’s data was erased.'
  if (contact.unsubscribedAt) return 'This person unsubscribed.'
  if (contact.emailStatus === 'invalid') return 'This address bounced, so a reply would not arrive.'
  if (await isSuppressed(db, orgId, contact.email)) return 'This person is on a do-not-contact list.'
  return null
}

export async function getThread(orgId: string, leadId: string) {
  const { lead, contact, campaign } = await ownedLead(orgId, leadId)
  const messages = await db
    .select()
    .from(t.messages)
    .where(
      and(
        eq(t.messages.leadId, leadId),
        or(
          inArray(t.messages.status, ['queued', 'sending', 'sent', 'unknown', 'failed', 'received']),
          and(eq(t.messages.status, 'cancelled'), inArray(t.messages.kind, ['manual_reply', 'auto_reply'])),
        ),
      ),
    )
    .orderBy(asc(t.messages.createdAt))
  const statuses = await db
    .select({ id: t.leadStatuses.id, name: t.leadStatuses.name })
    .from(t.leadStatuses)
    .where(eq(t.leadStatuses.projectId, campaign.projectId))
    .orderBy(t.leadStatuses.position)
  return { lead, contact, campaign, messages, statuses, replyBlockedReason: await replyBlocked(orgId, contact) }
}

/** The server picks recipient, subject and threading, so a reply can only reach this lead. */
export async function replyToLead(orgId: string, leadId: string, body: string) {
  const { contact } = await ownedLead(orgId, leadId)
  const blocked = await replyBlocked(orgId, contact)
  if (blocked) throw new ApiError(409, 'reply_blocked', blocked)
  const [last] = await db
    .select()
    .from(t.messages)
    .where(
      and(
        eq(t.messages.leadId, leadId),
        isNotNull(t.messages.rfcMessageId),
        inArray(t.messages.kind, ['first', 'followup', 'manual_reply', 'auto_reply', 'reply']),
      ),
    )
    .orderBy(desc(t.messages.createdAt))
    .limit(1)
  if (!last) throw new ApiError(409, 'no_thread', 'There is no conversation to reply to yet.')
  const subject = last.subject?.toLowerCase().startsWith('re:') ? last.subject : `Re: ${last.subject ?? ''}`
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(t.messages)
      .values({
        orgId,
        leadId,
        direction: 'outbound',
        kind: 'manual_reply',
        status: 'queued',
        subject,
        bodyText: body,
        toEmail: contact.email,
        mailboxId: last.mailboxId,
        inReplyTo: last.rfcMessageId,
        referencesHeader: [last.referencesHeader, last.rfcMessageId].filter(Boolean).join(' '),
      })
      .returning()
    await tx.update(t.leads).set({ needsReply: false }).where(eq(t.leads.id, leadId))
    await cancelAutoReplies(tx, leadId, 'you replied yourself')
    return message
  })
}

export async function updateLead(orgId: string, userId: string, leadId: string, input: z.infer<typeof leadUpdate>) {
  const { lead, campaign } = await ownedLead(orgId, leadId)
  if (!hasValues(input)) return lead
  if (input.status_id) {
    const [status] = await db
      .select()
      .from(t.leadStatuses)
      .where(and(eq(t.leadStatuses.id, input.status_id), eq(t.leadStatuses.projectId, campaign.projectId)))
    if (!status) throw new ApiError(400, 'unknown_status', 'Pick one of this project’s statuses.')
    if (lead.stage !== 'replied') throw new ApiError(409, 'no_reply_yet', 'Set a status after the lead has replied.')
  }
  const noteChanged = input.note !== undefined
  const [row] = await db
    .update(t.leads)
    .set({
      statusId: input.status_id,
      ...(noteChanged ? { note: input.note, noteUpdatedAt: sql`now()`, noteUpdatedBy: userId } : {}),
    })
    .where(eq(t.leads.id, leadId))
    .returning()
  return row
}

const cancelAutoReplies = (tx: Db, leadId: string, reason: string) =>
  tx
    .update(t.messages)
    .set({ status: 'cancelled', statusReason: reason })
    .where(and(eq(t.messages.leadId, leadId), eq(t.messages.kind, 'auto_reply'), eq(t.messages.status, 'queued')))

export async function markReplied(orgId: string, leadId: string) {
  await ownedLead(orgId, leadId)
  await cancelAutoReplies(db, leadId, 'you answered outside the app')
  const [row] = await db.update(t.leads).set({ needsReply: false }).where(eq(t.leads.id, leadId)).returning()
  return row
}

async function waitingAutoReply(orgId: string, id: string) {
  const [message] = await db
    .select()
    .from(t.messages)
    .where(and(eq(t.messages.orgId, orgId), eq(t.messages.id, id), eq(t.messages.kind, 'auto_reply')))
  if (!message) throw notFound('Message')
  if (message.status !== 'queued') throw new ApiError(409, 'not_waiting', 'This reply is no longer waiting.')
  return message
}

export async function sendAutoReplyNow(orgId: string, id: string) {
  await waitingAutoReply(orgId, id)
  const [row] = await db.update(t.messages).set({ sendAfter: sql`now()` }).where(eq(t.messages.id, id)).returning()
  return row
}

export async function cancelAutoReply(orgId: string, id: string) {
  await waitingAutoReply(orgId, id)
  const [row] = await db
    .update(t.messages)
    .set({ status: 'cancelled', statusReason: 'you cancelled it' })
    .where(eq(t.messages.id, id))
    .returning()
  return row
}
