import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, t, type Db } from '@/db'
import { ApiError, isUniqueViolation, notFound } from './http'
import { emailDomain, emailHash, isEmail, normalizeEmail } from './render'

export const suppressionCreate = z.strictObject({
  name: z.string().trim().min(1).max(120),
  entries: z.string().max(2_000_000),
})

/** One email or domain per line, or comma separated. */
export function parseEntries(text: string) {
  const entries = new Map<string, { kind: 'email' | 'domain'; value: string }>()
  for (const raw of text.split(/[\s,;]+/)) {
    const value = normalizeEmail(raw)
    if (!value) continue
    if (isEmail(value)) entries.set(value, { kind: 'email', value })
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) entries.set(value, { kind: 'domain', value })
  }
  return [...entries.values()]
}

export const listSuppression = (orgId: string) =>
  db
    .select({
      id: t.suppressionLists.id,
      name: t.suppressionLists.name,
      createdAt: t.suppressionLists.createdAt,
      total: count(t.suppressionEntries.id),
    })
    .from(t.suppressionLists)
    .leftJoin(t.suppressionEntries, eq(t.suppressionEntries.listId, t.suppressionLists.id))
    .where(eq(t.suppressionLists.orgId, orgId))
    .groupBy(t.suppressionLists.id)
    .orderBy(desc(t.suppressionLists.createdAt))

export async function createSuppression(orgId: string, input: z.infer<typeof suppressionCreate>) {
  const entries = parseEntries(input.entries)
  if (!entries.length) throw new ApiError(422, 'invalid', 'Add at least one email address or domain.')
  try {
    return await db.transaction(async (tx) => {
      const [list] = await tx.insert(t.suppressionLists).values({ orgId, name: input.name }).returning()
      await tx
        .insert(t.suppressionEntries)
        .values(entries.map((e) => ({ orgId, listId: list.id, ...e })))
        .onConflictDoNothing()
      return { ...list, added: entries.length }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'list_exists', 'You already have a list with this name.')
    throw err
  }
}

export async function getSuppression(orgId: string, id: string, page = 0) {
  const [list] = await db
    .select()
    .from(t.suppressionLists)
    .where(and(eq(t.suppressionLists.orgId, orgId), eq(t.suppressionLists.id, id)))
  if (!list) throw notFound('List')
  const entries = await db
    .select({ kind: t.suppressionEntries.kind, value: t.suppressionEntries.value })
    .from(t.suppressionEntries)
    .where(eq(t.suppressionEntries.listId, id))
    .orderBy(t.suppressionEntries.value)
    .limit(100)
    .offset(page * 100)
  return { ...list, entries }
}

export async function deleteSuppression(orgId: string, id: string) {
  const list = await getSuppression(orgId, id)
  if (list.name === 'Unsubscribed') {
    throw new ApiError(409, 'protected', 'This list holds opt-outs, so it cannot be deleted.')
  }
  await db.delete(t.suppressionLists).where(eq(t.suppressionLists.id, id))
}

export async function isSuppressed(tx: Db, orgId: string, email: string) {
  const [hit] = await tx
    .select({ id: t.suppressionEntries.id })
    .from(t.suppressionEntries)
    .where(
      and(
        eq(t.suppressionEntries.orgId, orgId),
        or(
          and(eq(t.suppressionEntries.kind, 'email'), eq(t.suppressionEntries.value, normalizeEmail(email))),
          and(eq(t.suppressionEntries.kind, 'email_hash'), eq(t.suppressionEntries.value, emailHash(email))),
          and(eq(t.suppressionEntries.kind, 'domain'), eq(t.suppressionEntries.value, emailDomain(email))),
        ),
      ),
    )
    .limit(1)
  return Boolean(hit)
}

export async function defaultList(tx: Db, orgId: string) {
  const [list] = await tx
    .select()
    .from(t.suppressionLists)
    .where(and(eq(t.suppressionLists.orgId, orgId), eq(t.suppressionLists.name, 'Unsubscribed')))
  return list ?? (await tx.insert(t.suppressionLists).values({ orgId, name: 'Unsubscribed' }).returning())[0]
}

async function stopContactMail(tx: Db, contactId: string, reason: string) {
  const rows = await tx.select({ id: t.leads.id }).from(t.leads).where(eq(t.leads.contactId, contactId))
  const ids = rows.map((r) => r.id)
  if (!ids.length) return
  await tx
    .update(t.messages)
    .set({ status: 'cancelled', statusReason: reason })
    .where(and(inArray(t.messages.leadId, ids), inArray(t.messages.status, ['queued', 'draft'])))
  await tx
    .update(t.leads)
    .set({ stage: 'stopped', needsReply: false })
    .where(and(inArray(t.leads.id, ids), inArray(t.leads.stage, ['review', 'active'])))
}

export const leadByToken = async (token: string) => {
  const [lead] = await db.select().from(t.leads).where(eq(t.leads.unsubscribeToken, token))
  return lead ?? null
}

/** Safe to repeat: mail clients may call one-click unsubscribe more than once. */
export async function unsubscribe(token: string) {
  const lead = await leadByToken(token)
  if (!lead) return false
  await db.transaction(async (tx) => {
    const [contact] = await tx.select().from(t.contacts).where(eq(t.contacts.id, lead.contactId))
    if (!contact || contact.unsubscribedAt) return
    await tx.update(t.contacts).set({ unsubscribedAt: sql`now()` }).where(eq(t.contacts.id, contact.id))
    if (contact.email) {
      const list = await defaultList(tx, lead.orgId)
      await tx
        .insert(t.suppressionEntries)
        .values({ orgId: lead.orgId, listId: list.id, kind: 'email', value: normalizeEmail(contact.email) })
        .onConflictDoNothing()
    }
    await stopContactMail(tx, contact.id, 'unsubscribed')
    await tx.insert(t.auditEvents).values({
      orgId: lead.orgId,
      actor: 'system',
      action: 'contact.unsubscribed',
      subjectType: 'contact',
      subjectId: contact.id,
    })
  })
  return true
}
