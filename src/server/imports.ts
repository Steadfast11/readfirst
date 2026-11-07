import { parse } from 'csv-parse/sync'
import { and, eq, gt, sql } from 'drizzle-orm'
import { db, t } from '@/db'
import { ApiError, notFound } from './http'
import { verifyCampaign } from './leadsource'
import { getProject } from './projects'
import { emailDomain, isEmail, normalizeEmail } from './render'
import { isSuppressed } from './suppression'

export const MAX_ROWS = 30_000
export const MAX_BYTES = 10 * 1024 * 1024

const HEADERS: Record<string, string[]> = {
  email: ['email', 'e-mail', 'email address', 'work email'],
  first_name: ['first_name', 'first name', 'firstname', 'given name'],
  last_name: ['last_name', 'last name', 'lastname', 'surname', 'family name'],
  company_name: ['company_name', 'company', 'company name', 'organization', 'organisation'],
  company_domain: ['company_domain', 'domain', 'website', 'company website'],
  job_title: ['job_title', 'title', 'job title', 'role', 'position'],
  country: ['country'],
}

export function mapHeaders(columns: string[]) {
  const mapped: Record<string, string> = {}
  for (const [field, names] of Object.entries(HEADERS)) {
    const hit = columns.find((c) => names.includes(c.trim().toLowerCase()))
    if (hit) mapped[field] = hit
  }
  return mapped
}

/** Excel saves UTF-16 or Windows-1252 as often as UTF-8. Guessing wrong would misspell people's names. */
export function decodeCsv(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

export function detectDelimiter(csv: string) {
  const header = csv.split(/\r?\n/, 1)[0] ?? ''
  const count = (d: string) => header.split(d).length - 1
  return [',', ';', '\t'].reduce((best, d) => (count(d) > count(best) ? d : best), ',')
}

function readCsv(csv: string) {
  return parse(csv, {
    columns: true,
    delimiter: detectDelimiter(csv),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[]
}

export async function createImport(orgId: string, projectId: string, name: string, csv: string) {
  await getProject(orgId, projectId)
  let rows: Record<string, string>[]
  try {
    rows = readCsv(csv)
  } catch {
    throw new ApiError(422, 'invalid_csv', 'We could not read this file as a CSV.')
  }
  if (!rows.length) throw new ApiError(422, 'empty_csv', 'This file has no rows.')
  if (rows.length > MAX_ROWS) throw new ApiError(422, 'too_many_rows', `Import up to ${MAX_ROWS.toLocaleString('en')} rows at a time.`)
  const mapped = mapHeaders(Object.keys(rows[0]))
  if (!mapped.email) throw new ApiError(422, 'no_email_column', 'Add a column named email.')
  const [row] = await db
    .insert(t.imports)
    .values({ orgId, projectId, name, total: rows.length, sourceCsv: csv })
    .returning({ id: t.imports.id })
  return { id: row.id, total: rows.length, columns: mapped }
}

export async function getImport(orgId: string, id: string) {
  const [row] = await db
    .select({
      id: t.imports.id,
      projectId: t.imports.projectId,
      campaignId: t.imports.campaignId,
      name: t.imports.name,
      status: t.imports.status,
      stage: t.imports.stage,
      createdAt: t.imports.createdAt,
      done: t.imports.done,
      total: t.imports.total,
      error: t.imports.error,
    })
    .from(t.imports)
    .where(and(eq(t.imports.orgId, orgId), eq(t.imports.id, id)))
  if (!row) throw notFound('Import')
  const totals = await db
    .select({ outcome: t.importRows.outcome, reason: t.importRows.reason, n: sql<number>`count(*)::int` })
    .from(t.importRows)
    .where(eq(t.importRows.importId, id))
    .groupBy(t.importRows.outcome, t.importRows.reason)
  return { ...row, totals }
}

export async function importRows(orgId: string, id: string, page = 0) {
  await getImport(orgId, id)
  return db
    .select({ row: t.importRows.rowIndex, outcome: t.importRows.outcome, reason: t.importRows.reason })
    .from(t.importRows)
    .where(eq(t.importRows.importId, id))
    .orderBy(t.importRows.rowIndex)
    .limit(200)
    .offset(page * 200)
}

const setStage = (id: string, stage: string, done = 0) =>
  db.update(t.imports).set({ stage, done }).where(eq(t.imports.id, id))

/** Worker job. The raw CSV is removed when it finishes, so people's data is not kept twice. */
export async function runImport(id: string) {
  const [job] = await db.select().from(t.imports).where(eq(t.imports.id, id))
  if (!job || job.status !== 'pending') return
  try {
    if (!job.sourceCsv) {
      // The rows were saved before a crash. Only the email check and the status are left.
      if (job.campaignId) await verifyCampaign({ id: job.campaignId, orgId: job.orgId, projectId: job.projectId })
      await db.update(t.imports).set({ status: 'completed', stage: null }).where(eq(t.imports.id, id))
      return
    }
    await setStage(id, 'validating')
    const records = readCsv(job.sourceCsv)
    const cols = mapHeaders(Object.keys(records[0] ?? {}))
    const value = (r: Record<string, string>, f: string) => (cols[f] ? r[cols[f]]?.trim() || null : null)
    const seen = new Set<string>()
    const outcomes: { rowIndex: number; contactId?: string; reason?: string }[] = []

    let verify: { id: string; orgId: string; projectId: string } | null = null
    await db.transaction(async (tx) => {
      const [campaign] = await tx
        .insert(t.campaigns)
        .values({ orgId: job.orgId, projectId: job.projectId, name: job.name, source: 'import', status: 'review' })
        .returning()
      let imported = 0
      for (const [rowIndex, r] of records.entries()) {
        const email = value(r, 'email')
        if (!email || !value(r, 'first_name')) outcomes.push({ rowIndex, reason: 'missing_fields' })
        else if (!isEmail(email)) outcomes.push({ rowIndex, reason: 'invalid_email' })
        else if (seen.has(normalizeEmail(email))) outcomes.push({ rowIndex, reason: 'duplicate_in_file' })
        else if (await isSuppressed(tx, job.orgId, email)) outcomes.push({ rowIndex, reason: 'suppressed' })
        else {
          const address = normalizeEmail(email)
          seen.add(address)
          const rows = await tx.execute<{ id: string; unsubscribed_at: string | null }>(sql`
            insert into contacts (org_id, email, first_name, last_name, job_title, company_name, company_domain, country, source, source_detail)
            values (${job.orgId}, ${address}, ${value(r, 'first_name')}, ${value(r, 'last_name')}, ${value(r, 'job_title')},
                    ${value(r, 'company_name')}, ${value(r, 'company_domain') ?? emailDomain(address)}, ${value(r, 'country')},
                    'import', ${job.name})
            on conflict (org_id, lower(email)) where email is not null
            do update set updated_at = now()
            returning id, unsubscribed_at`)
          const contact = rows.rows[0]
          const [contacted] = await tx
            .select({ id: t.leads.id })
            .from(t.leads)
            .where(and(eq(t.leads.contactId, contact.id), gt(t.leads.touchesSent, 0)))
            .limit(1)
          if (contact.unsubscribed_at) outcomes.push({ rowIndex, reason: 'suppressed' })
          else if (contacted) outcomes.push({ rowIndex, reason: 'already_contacted' })
          else {
            await tx.insert(t.leads).values({ orgId: job.orgId, campaignId: campaign.id, contactId: contact.id })
            outcomes.push({ rowIndex, contactId: contact.id })
            imported++
          }
        }
        if (rowIndex % 500 === 499) await setStage(id, 'saving', rowIndex + 1)
      }
      for (let i = 0; i < outcomes.length; i += 1000) {
        await tx.insert(t.importRows).values(
          outcomes.slice(i, i + 1000).map((o) => ({
            orgId: job.orgId,
            importId: id,
            rowIndex: o.rowIndex,
            contactId: o.contactId,
            outcome: o.contactId ? 'imported' : 'skipped',
            reason: o.reason,
          })),
        )
      }
      if (imported === 0) await tx.delete(t.campaigns).where(eq(t.campaigns.id, campaign.id))
      else verify = campaign
      await tx
        .update(t.imports)
        .set({ stage: 'verifying', done: records.length, campaignId: imported ? campaign.id : null, sourceCsv: null })
        .where(eq(t.imports.id, id))
    })
    if (verify) await verifyCampaign(verify)
    await db.update(t.imports).set({ status: 'completed', stage: null }).where(eq(t.imports.id, id))
  } catch (err) {
    console.error('import failed', id, err)
    await db
      .update(t.imports)
      .set({ status: 'failed', error: 'We could not finish this import. Check the file and try again.', sourceCsv: null })
      .where(eq(t.imports.id, id))
  }
}
