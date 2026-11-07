import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { simpleParser, type ParsedMail } from 'mailparser'
import { db, t, type Tx } from '@/db'
import { contactVars, needsAi, resolveFirstEmail } from './campaigns'
import { verifierConfigured } from './leadsource'
import { imapClient, smtpTransport, type MailboxRow } from './projects'
import { composeBody, emailDomain, isStopRequest, normalizeEmail, renderTemplate, withinSendWindow } from './render'
import { budgetStop } from './spend'
import { isSuppressed, unsubscribe } from './suppression'

type Message = typeof t.messages.$inferSelect
type Row = {
  message: Message
  lead: typeof t.leads.$inferSelect
  contact: typeof t.contacts.$inferSelect
  campaign: typeof t.campaigns.$inferSelect
}

const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000'
const unsubscribeUrl = (token: string) => `${appUrl()}/u/${token}`

/** The desktop app has no public address, so a link in an email could never open. Opting out works by reply. */
const noPublicUrl = () => Boolean(process.env.DESKTOP_TOKEN)
const stopLine = (token: string) =>
  noPublicUrl() ? 'To stop these emails, reply with the word stop.' : `To stop these emails: ${unsubscribeUrl(token)}`
const unsubscribeHeaders = (token: string, mailbox: string): Record<string, string> =>
  noPublicUrl()
    ? { 'List-Unsubscribe': `<mailto:${mailbox}?subject=unsubscribe>` }
    : { 'List-Unsubscribe': `<${unsubscribeUrl(token)}/confirm>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }

const LEGAL_MISSING = 'legal details missing'

/** The last check before anything leaves. Returns why not, or null to send. */
export async function sendBlocker(tx: Tx, r: Row, project: typeof t.projects.$inferSelect) {
  const { contact, lead, campaign, message } = r
  if (!contact.email || contact.erasedAt) return 'contact erased'
  if (contact.unsubscribedAt) return 'unsubscribed'
  if (await isSuppressed(tx, r.lead.orgId, contact.email)) return 'suppressed'
  if (contact.emailStatus === 'invalid') return 'invalid email'
  if (message.kind === 'manual_reply') return null
  if (!project.legalFooter.trim() || !project.legalBasisConfirmedAt) return LEGAL_MISSING
  if (message.kind === 'auto_reply') {
    if (!project.autoReplyEnabled) return 'auto-replies turned off'
    return campaign.status === 'sending' ? null : 'campaign not sending'
  }
  if (verifierConfigured() && message.kind === 'first' && contact.emailStatus === 'unknown') return 'email not verified'
  if (campaign.status !== 'sending' || !campaign.approvedAt) return 'campaign not approved'
  if (lead.stage !== 'active') return 'lead no longer active'
  const [other] = await tx
    .select({ id: t.messages.id })
    .from(t.messages)
    .innerJoin(t.leads, eq(t.leads.id, t.messages.leadId))
    .where(
      and(
        eq(t.leads.contactId, contact.id),
        ne(t.messages.leadId, lead.id),
        inArray(t.messages.kind, ['first', 'followup']),
        inArray(t.messages.status, ['sending', 'sent', 'unknown']),
      ),
    )
    .limit(1)
  return other ? 'already emailed by another campaign' : null
}

function sendGapSeconds() {
  const base = Number(process.env.SEND_GAP_SECONDS ?? 120)
  return base * (0.7 + Math.random() * 0.6)
}

async function mailboxHasCapacity(box: MailboxRow, timezone: string) {
  const startOfDay = DateTime.utc().setZone(timezone).startOf('day').toUTC().toISO()!
  const [today] = await db
    .select({ n: count() })
    .from(t.messages)
    .where(
      and(
        eq(t.messages.mailboxId, box.id),
        inArray(t.messages.status, ['sending', 'sent', 'unknown']),
        gte(t.messages.claimedAt, startOfDay),
      ),
    )
  if (today.n >= box.dailyLimit) return false
  const [last] = await db
    .select({ at: t.messages.claimedAt })
    .from(t.messages)
    .where(and(eq(t.messages.mailboxId, box.id), inArray(t.messages.status, ['sending', 'sent', 'unknown'])))
    .orderBy(desc(t.messages.claimedAt))
    .limit(1)
  if (!last?.at) return true
  return Date.now() - new Date(last.at).getTime() >= sendGapSeconds() * 1000
}

/** Claims one message. Commits before SMTP, because SMTP cannot share a transaction. */
async function claim(box: MailboxRow, project: typeof t.projects.$inferSelect, kinds: string[], campaignIds?: string[]) {
  return db.transaction(async (tx) => {
    for (;;) {
      const [r] = await tx
        .select({ message: t.messages, lead: t.leads, contact: t.contacts, campaign: t.campaigns })
        .from(t.messages)
        .innerJoin(t.leads, eq(t.leads.id, t.messages.leadId))
        .innerJoin(t.contacts, eq(t.contacts.id, t.leads.contactId))
        .innerJoin(t.campaigns, eq(t.campaigns.id, t.leads.campaignId))
        .where(
          and(
            eq(t.messages.status, 'queued'),
            eq(t.messages.needsDraft, false),
            inArray(t.messages.kind, kinds),
            or(isNull(t.messages.mailboxId), eq(t.messages.mailboxId, box.id)),
            eq(t.campaigns.projectId, box.projectId),
            or(isNull(t.messages.sendAfter), lt(t.messages.sendAfter, sql`now()`)),
            campaignIds ? inArray(t.campaigns.id, campaignIds) : undefined,
          ),
        )
        .orderBy(t.messages.createdAt)
        .limit(1)
        .for('update', { of: t.messages, skipLocked: true })
      if (!r) return null
      // One sender at a time per person, so two campaigns cannot both pass the check below.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${r.contact.id}))`)
      const blocked = await sendBlocker(tx, r, project)
      if (blocked === LEGAL_MISSING) return null // Fixable in settings, so nothing is cancelled.
      if (blocked) {
        await tx.update(t.messages).set({ status: 'cancelled', statusReason: blocked }).where(eq(t.messages.id, r.message.id))
        if (r.message.kind === 'first' || r.message.kind === 'followup') {
          await tx.update(t.leads).set({ stage: 'stopped' }).where(eq(t.leads.id, r.lead.id))
        }
        continue
      }
      const content = await buildContent(tx, r, project)
      if ('error' in content) {
        await tx.update(t.messages).set({ status: 'failed', statusReason: content.error }).where(eq(t.messages.id, r.message.id))
        await tx.update(t.leads).set({ stage: 'stopped' }).where(eq(t.leads.id, r.lead.id))
        continue
      }
      const rfcMessageId = `<${randomUUID()}@${emailDomain(box.email)}>`
      const [message] = await tx
        .update(t.messages)
        .set({
          status: 'sending',
          claimedAt: sql`now()`,
          mailboxId: box.id,
          fromEmail: box.email,
          toEmail: r.contact.email,
          subject: content.subject,
          bodyText: content.body,
          rfcMessageId,
        })
        .where(eq(t.messages.id, r.message.id))
        .returning()
      return { ...r, message }
    }
  })
}

async function buildContent(tx: Tx, r: Row, project: typeof t.projects.$inferSelect) {
  if (r.message.kind === 'manual_reply') return { subject: r.message.subject ?? '', body: r.message.bodyText ?? '' }
  const wrap = (body: string) =>
    composeBody(body, { senderName: project.senderName, footer: project.legalFooter, stopLine: stopLine(r.lead.unsubscribeToken) })
  // Written ahead of time, by AI.
  if (r.message.subject && r.message.bodyText) return { subject: r.message.subject, body: wrap(r.message.bodyText) }
  const email = await resolveFirstEmail(r.campaign)
  if (!email.body || !email.subject) return { error: 'no first email written' }
  const vars = contactVars(r.contact)
  const subject = renderTemplate(email.subject, vars, r.contact.id)
  const body = renderTemplate(email.body, vars, r.contact.id)
  const missing = [...subject.missing, ...body.missing]
  if (missing.length) return { error: `no value for ${missing.join(', ')}` }
  return { subject: subject.text, body: wrap(body.text) }
}

/** After a touch: when the next one is due, or that this lead is finished. */
async function afterTouch(r: Row) {
  const { campaign, message } = r
  if (!message.touch) return {}
  const email = await resolveFirstEmail(campaign)
  const more = message.touch < campaign.maxTouches && (needsAi(email) || campaign.followupInstructions.trim() !== '')
  if (more) return { nextTouchAt: sql`now() + ${`${campaign.followupDelayDays} days`}::interval` }
  return { stage: 'finished', nextTouchAt: null }
}

async function deliver(box: MailboxRow, project: typeof t.projects.$inferSelect, r: Row) {
  const { message, lead } = r
  // Worked out first: once SMTP accepts the mail, nothing may turn it into a failure.
  const next = await afterTouch(r)
  try {
    const transport = await smtpTransport(box)
    await transport.sendMail({
      from: { name: project.senderName || box.displayName || box.email, address: box.email },
      to: message.toEmail!,
      subject: message.subject ?? '',
      text: message.bodyText ?? '',
      messageId: message.rfcMessageId!,
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.referencesHeader ?? undefined,
      headers: unsubscribeHeaders(lead.unsubscribeToken, box.email),
    })
    await db.transaction(async (tx) => {
      await tx.update(t.messages).set({ status: 'sent', sentAt: sql`now()` }).where(eq(t.messages.id, message.id))
      await tx
        .update(t.leads)
        .set({
          ...next,
          lastMessageAt: sql`now()`,
          touchesSent: message.touch ? sql`${t.leads.touchesSent} + 1` : undefined,
          needsReply: message.kind === 'auto_reply' ? false : undefined,
        })
        .where(eq(t.leads.id, lead.id))
    })
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string }
    if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(e.code ?? '')) {
      // Rejected before the message was accepted, so it is safe to try again later.
      await db.update(t.messages).set({ status: 'queued', claimedAt: null, rfcMessageId: null }).where(eq(t.messages.id, message.id))
      await db
        .update(t.mailboxes)
        .set({ status: 'failing', statusReason: 'The sending server refused the connection or sign-in.' })
        .where(eq(t.mailboxes.id, box.id))
      return
    }
    await db.update(t.messages).set({ status: 'failed', statusReason: e.message?.slice(0, 300) }).where(eq(t.messages.id, message.id))
    if (e.code === 'EENVELOPE' && message.touch) {
      // The server refused this recipient outright, so it counts as a bounce.
      await db.update(t.leads).set({ stage: 'bounced' }).where(eq(t.leads.id, lead.id))
      await db.update(t.contacts).set({ emailStatus: 'invalid' }).where(eq(t.contacts.id, lead.contactId))
    }
  }
}

const activeBoxes = () =>
  db
    .select({ box: t.mailboxes, project: t.projects })
    .from(t.mailboxes)
    .innerJoin(t.projects, eq(t.projects.id, t.mailboxes.projectId))
    .where(and(eq(t.mailboxes.status, 'active'), isNull(t.projects.archivedAt)))

async function followUpDue(projectId: string) {
  const [row] = await db
    .select({ id: t.messages.id })
    .from(t.messages)
    .innerJoin(t.leads, eq(t.leads.id, t.messages.leadId))
    .innerJoin(t.campaigns, eq(t.campaigns.id, t.leads.campaignId))
    .where(and(eq(t.campaigns.projectId, projectId), eq(t.messages.kind, 'followup'), eq(t.messages.status, 'queued'), eq(t.messages.needsDraft, false)))
    .orderBy(asc(t.messages.createdAt))
    .limit(1)
  return Boolean(row)
}

/** One pass: each mailbox sends waiting replies, then at most one campaign email. */
export async function sendTick() {
  let sent = 0
  for (const { box, project } of await activeBoxes()) {
    for (;;) {
      const reply = await claim(box, project, ['manual_reply', 'auto_reply'])
      if (!reply) break
      await deliver(box, project, reply)
      sent++
    }
    if (await budgetStop(project)) continue
    if (!(await mailboxHasCapacity(box, project.timezone))) continue
    const campaigns = await db
      .select()
      .from(t.campaigns)
      .where(and(eq(t.campaigns.projectId, box.projectId), eq(t.campaigns.status, 'sending')))
    const open = campaigns.filter((c) => withinSendWindow(c, project.timezone)).map((c) => c.id)
    if (!open.length) continue
    // A reply may be waiting. Read it first, so a follow-up does not cross it.
    if (await followUpDue(box.projectId)) await pollOne(box).catch(() => [])
    const next = await claim(box, project, ['first', 'followup'], open)
    if (next) {
      await deliver(box, project, next)
      sent++
    }
  }
  return sent
}

/** A crash mid-send leaves the outcome unknown. Never resend it. */
export async function reapStuck() {
  const rows = await db
    .update(t.messages)
    .set({ status: 'unknown', statusReason: 'We could not confirm this email was sent.' })
    .where(and(eq(t.messages.status, 'sending'), lt(t.messages.claimedAt, sql`now() - interval '10 minutes'`)))
    .returning({ id: t.messages.id })
  return rows.length
}

const headerIds = (value: unknown) => String(value ?? '').match(/<[^>\s]+>/g) ?? []

function isAutoResponse(mail: ParsedMail) {
  const auto = String(mail.headers.get('auto-submitted') ?? 'no').toLowerCase()
  const precedence = String(mail.headers.get('precedence') ?? '').toLowerCase()
  return auto !== 'no' || mail.headers.has('x-autoreply') || mail.headers.has('x-autorespond') || precedence === 'auto_reply'
}

function isBounce(mail: ParsedMail, raw: string) {
  const from = mail.from?.value[0]?.address?.toLowerCase() ?? ''
  return /^(mailer-daemon|postmaster)@/.test(from) || /content-type:\s*multipart\/report/i.test(raw.slice(0, 4000))
}

async function findOriginal(orgId: string, ids: string[]) {
  if (!ids.length) return null
  const [row] = await db
    .select({ message: t.messages })
    .from(t.messages)
    .where(and(eq(t.messages.orgId, orgId), eq(t.messages.direction, 'outbound'), inArray(t.messages.rfcMessageId, ids)))
    .limit(1)
  return row?.message ?? null
}

/** Two polls can pass the "seen it?" check together. The unique index decides, and the loser changes nothing. */
async function storeOnce(result: string, work: (tx: Tx) => Promise<void>) {
  try {
    await db.transaction(work)
    return result
  } catch (err) {
    const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }
    const pg = e.cause ?? e
    if (pg.code === '23505' && pg.constraint === 'messages_rfc_id') return 'duplicate'
    throw err
  }
}

/** Stores one incoming email. Exported so tests can feed it directly. */
export async function handleInbound(box: MailboxRow, raw: string) {
  const mail = await simpleParser(raw)
  // Some senders leave Message-ID out. A hash of the mail stands in, so the unique index still sees a repeat.
  const rfcId = mail.messageId ?? `<${createHash('sha256').update(raw).digest('hex')}@no-message-id.invalid>`
  const from = normalizeEmail(mail.from?.value[0]?.address ?? '')
  if (from === box.email) return 'own'
  const [known] = await db
    .select({ id: t.messages.id })
    .from(t.messages)
    .where(and(eq(t.messages.orgId, box.orgId), eq(t.messages.rfcMessageId, rfcId)))
  if (known) return 'duplicate'
  if (isBounce(mail, raw)) {
    const ids = raw.match(/^message-id:\s*(<[^>\s]+>)/gim)?.map((m) => m.replace(/^message-id:\s*/i, '')) ?? []
    const original = await findOriginal(box.orgId, ids)
    if (!original) return 'unmatched'
    return storeOnce('bounce', async (tx) => {
      await tx.insert(t.messages).values({
        orgId: box.orgId,
        leadId: original.leadId,
        mailboxId: box.id,
        direction: 'inbound',
        kind: 'bounce',
        status: 'received',
        subject: mail.subject ?? null,
        bodyText: mail.text?.slice(0, 2000) ?? null,
        fromEmail: from,
        rfcMessageId: rfcId,
        receivedAt: sql`now()`,
      })
      const [lead] = await tx.update(t.leads).set({ stage: 'bounced' }).where(eq(t.leads.id, original.leadId)).returning()
      await tx.update(t.contacts).set({ emailStatus: 'invalid' }).where(eq(t.contacts.id, lead.contactId))
      await tx
        .update(t.messages)
        .set({ status: 'cancelled', statusReason: 'bounced' })
        .where(and(eq(t.messages.leadId, original.leadId), eq(t.messages.status, 'queued')))
    })
  }
  const thread = [...headerIds(mail.inReplyTo), ...headerIds(mail.references)]
  const original = await findOriginal(box.orgId, thread)
  let leadId = original?.leadId
  if (!leadId) {
    const [byAddress] = await db
      .select({ id: t.leads.id })
      .from(t.leads)
      .innerJoin(t.contacts, eq(t.contacts.id, t.leads.contactId))
      .innerJoin(t.campaigns, eq(t.campaigns.id, t.leads.campaignId))
      .where(and(eq(t.contacts.email, from), eq(t.campaigns.projectId, box.projectId), sql`${t.leads.touchesSent} > 0`))
      .orderBy(desc(t.leads.lastMessageAt))
      .limit(1)
    leadId = byAddress?.id
  }
  if (!leadId) return 'unmatched'
  const auto = isAutoResponse(mail)
  const matchedLead = leadId
  const stored = await storeOnce(auto ? 'auto_response' : 'reply', async (tx) => {
    await tx.insert(t.messages).values({
      orgId: box.orgId,
      leadId: matchedLead,
      mailboxId: box.id,
      direction: 'inbound',
      kind: auto ? 'auto_response' : 'reply',
      status: 'received',
      subject: mail.subject ?? null,
      bodyText: mail.text ?? null,
      fromEmail: from,
      toEmail: box.email,
      rfcMessageId: rfcId,
      inReplyTo: headerIds(mail.inReplyTo)[0] ?? null,
      referencesHeader: headerIds(mail.references).join(' ') || null,
      receivedAt: sql`now()`,
    })
    if (auto) return
    await tx
      .update(t.leads)
      .set({ stage: 'replied', needsReply: true, lastMessageAt: sql`now()`, nextTouchAt: null })
      .where(eq(t.leads.id, matchedLead))
    await tx
      .update(t.messages)
      .set({ status: 'cancelled', statusReason: 'lead replied' })
      .where(and(eq(t.messages.leadId, matchedLead), eq(t.messages.status, 'queued'), inArray(t.messages.kind, ['first', 'followup', 'auto_reply'])))
  })
  if (stored === 'reply' && isStopRequest(mail.subject ?? '', mail.text ?? '')) {
    const [lead] = await db.select({ token: t.leads.unsubscribeToken }).from(t.leads).where(eq(t.leads.id, matchedLead))
    await unsubscribe(lead.token)
  }
  return stored
}

async function pollOne(box: MailboxRow) {
  const client = await imapClient(box)
  client.on('error', () => {})
  const results: string[] = []
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const state = client.mailbox
      const validity = state ? Number(state.uidValidity) : null
      let last = Number(box.imapLastUid)
      if (validity !== null && box.imapUidvalidity !== null && Number(box.imapUidvalidity) !== validity) last = 0
      let highest = last
      if (state && state.exists > 0) {
        for await (const item of client.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (item.uid <= last || !item.source) continue
          results.push(await handleInbound(box, item.source.toString('utf8')))
          highest = Math.max(highest, item.uid)
        }
      }
      await db
        .update(t.mailboxes)
        .set({ imapLastUid: highest, imapUidvalidity: validity, lastPolledAt: sql`now()` })
        .where(eq(t.mailboxes.id, box.id))
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
  return results
}

export async function pollMailboxes() {
  const results: string[] = []
  for (const { box } of await activeBoxes()) {
    try {
      results.push(...(await pollOne(box)))
    } catch (err) {
      console.error('poll failed', box.email, (err as Error).message)
    }
  }
  return results
}
