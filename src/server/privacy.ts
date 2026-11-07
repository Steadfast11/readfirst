import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, t } from '@/db'
import { ApiError, notFound } from './http'
import { emailHash, normalizeEmail } from './render'
import { defaultList } from './suppression'

export async function findContact(orgId: string, email: string) {
  const [contact] = await db
    .select()
    .from(t.contacts)
    .where(and(eq(t.contacts.orgId, orgId), sql`lower(${t.contacts.email}) = ${normalizeEmail(email)}`))
  return contact ?? null
}

async function owned(orgId: string, id: string) {
  const [contact] = await db.select().from(t.contacts).where(and(eq(t.contacts.orgId, orgId), eq(t.contacts.id, id)))
  if (!contact) throw notFound('Person')
  return contact
}

/** Everything held about one person, for a data request. */
export async function exportContact(orgId: string, id: string) {
  const contact = await owned(orgId, id)
  const leads = await db.select().from(t.leads).where(eq(t.leads.contactId, id))
  const messages = leads.length
    ? await db
        .select({
          direction: t.messages.direction,
          subject: t.messages.subject,
          body: t.messages.bodyText,
          sentAt: t.messages.sentAt,
          receivedAt: t.messages.receivedAt,
        })
        .from(t.messages)
        .where(inArray(t.messages.leadId, leads.map((l) => l.id)))
    : []
  return {
    contact,
    campaigns: leads.map((l) => ({ stage: l.stage, note: l.note, whyHot: l.whyHot, fitReason: l.fitReason, createdAt: l.createdAt })),
    messages,
  }
}

/** Blanks the person and every email to or from them. A hash stays, so they are never contacted again. */
export async function eraseContact(orgId: string, userId: string, id: string) {
  const contact = await owned(orgId, id)
  if (contact.erasedAt) return { id, erased: true }
  if (!contact.email) throw new ApiError(409, 'no_email', 'This person has no email address.')
  await db.transaction(async (tx) => {
    const address = normalizeEmail(contact.email!)
    const list = await defaultList(tx, orgId)
    await tx.delete(t.suppressionEntries).where(and(eq(t.suppressionEntries.orgId, orgId), eq(t.suppressionEntries.kind, 'email'), eq(t.suppressionEntries.value, address)))
    await tx
      .insert(t.suppressionEntries)
      .values({ orgId, listId: list.id, kind: 'email_hash', value: emailHash(address) })
      .onConflictDoNothing()
    await tx
      .update(t.contacts)
      .set({
        email: null,
        firstName: null,
        lastName: null,
        jobTitle: null,
        linkedinUrl: null,
        phone: null,
        companyName: null,
        companyDomain: null,
        country: null,
        sourceDetail: null,
        erasedAt: sql`now()`,
      })
      .where(eq(t.contacts.id, id))
    await tx.execute(sql`
      update messages m set
        subject = null, body_text = null, from_email = null, to_email = null, status_reason = null, intent_reason = null,
        erased_at = now(), status = case when m.status = 'queued' then 'cancelled' else m.status end
      from leads l where l.id = m.lead_id and l.contact_id = ${id}`)
    await tx
      .update(t.leads)
      .set({ note: null, whyHot: null, fitReason: null, needsReply: false, nextTouchAt: null, stage: 'stopped' })
      .where(eq(t.leads.contactId, id))
    await tx.insert(t.auditEvents).values({ orgId, actorUserId: userId, actor: 'user', action: 'contact.erased', subjectType: 'contact', subjectId: id })
  })
  return { id, erased: true }
}
