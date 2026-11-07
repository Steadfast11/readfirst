import { PgBoss } from 'pg-boss'
import { api, approve, campaign, expect, leadsOf, login, newProject, pool, someLeads, test, tick, toCsv, uid, upload } from './helpers'

const reasons = (job: { totals: { reason: string | null; n: number }[] }) => Object.fromEntries(job.totals.map((t) => [t.reason ?? 'imported', t.n]))

test.describe('F05 import', () => {
  let projectId: string
  test.beforeEach(async ({ page }) => {
    await login(page)
    projectId = (await newProject(page)).projectId
  })

  test('F05-E1 a semicolon CSV from European Excel imports', async ({ page }) => {
    const id = uid()
    const job = await upload(page, projectId, `email;first_name;company\nsemi${id}@clinic.test;Ana;Acme\n`)
    expect(job.status).toBe('completed')
    expect(reasons(job).imported).toBe(1)
  })

  test('F05-E11 a list left waiting says so instead of spinning quietly', async ({ page }) => {
    const { rows } = await pool.query(
      `insert into imports (org_id, project_id, name, total, source_csv, created_at)
       select org_id, id, 'Waiting', 1, 'email,first_name', now() - interval '10 minutes' from projects where id = $1 returning id`,
      [projectId],
    )
    await page.goto(`/projects/${projectId}/imports/${rows[0].id}`)
    await expect(page.getByRole('status')).toContainText('taking longer than usual')
    await expect(page.getByRole('status')).toContainText('Your list is saved')
  })

  test('F05-E12 a fresh list does not show the delay message', async ({ page }) => {
    const { rows } = await pool.query(
      `insert into imports (org_id, project_id, name, total, source_csv) select org_id, id, 'Fresh', 1, 'email,first_name' from projects where id = $1 returning id`,
      [projectId],
    )
    await page.goto(`/projects/${projectId}/imports/${rows[0].id}`)
    await expect(page.getByRole('status')).toContainText('Checking your list')
    await expect(page.getByRole('status')).not.toContainText('longer than usual')
  })

  test('F05-E13 an import stopped after saving finishes when the job runs again', async ({ page }) => {
    const job = await upload(page, projectId, toCsv(someLeads(1)))
    await pool.query(`update imports set status = 'pending', stage = 'verifying' where id = $1`, [job.id])
    const boss = new PgBoss({ connectionString: 'postgres://postgres@localhost:54329/outreach', supervise: false, schedule: false })
    boss.on('error', () => {})
    await boss.start()
    await boss.send('run-import', { id: job.id })
    await expect.poll(async () => (await api(page, 'GET', `/api/imports/${job.id}`)).json.status, { timeout: 20000 }).toBe('completed')
    await boss.stop({ graceful: false })
  })

  test('F05-E2 a Windows-1252 file keeps its accents', async ({ page }) => {
    const id = uid()
    const job = await upload(page, projectId, Buffer.from(`email,first_name\nwin${id}@clinic.test,José\n`, 'latin1'))
    const rows = await leadsOf(page, job.campaignId)
    expect(rows[0].contact.firstName).toBe('José')
  })

  test('F05-E10 a UTF-16 file from Excel keeps its accents', async ({ page }) => {
    const text = `email\tfirst_name\nu16${uid()}@clinic.test\tJosé\n`
    const job = await upload(page, projectId, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    const rows = await leadsOf(page, job.campaignId)
    expect(rows[0].contact.firstName).toBe('José')
  })

  test('F05-E3 a BOM and capitalised headers work', async ({ page }) => {
    const job = await upload(page, projectId, `﻿Email,First Name\nBOM${uid()}@Clinic.test,Ana\n`)
    const rows = await leadsOf(page, job.campaignId)
    expect(rows[0].contact.email).toMatch(/^bom/)
  })

  test('F05-E4 5,000 rows finish quickly', async ({ page }) => {
    const started = Date.now()
    const job = await upload(page, projectId, toCsv(someLeads(5000)))
    expect(reasons(job).imported).toBe(5000)
    expect(Date.now() - started).toBeLessThan(25_000)
  })

  test('F05-E5 someone already emailed is skipped', async ({ page }) => {
    const leads = someLeads(1)
    const c = await campaign(page, leads, projectId)
    await approve(page, c.campaignId)
    await tick()
    const job = await upload(page, projectId, toCsv(leads))
    expect(reasons(job).already_contacted).toBe(1)
    expect(job.campaignId).toBeNull()
  })

  test('F05-E6 an address with a comma is refused', async ({ page }) => {
    const job = await upload(page, projectId, `email,first_name\n"a,b${uid()}@clinic.test",Ana\n`)
    expect(reasons(job).invalid_email).toBe(1)
  })

  test('F05-E7 the raw file is not kept after import', async ({ page }) => {
    const job = await upload(page, projectId, toCsv(someLeads(1)))
    const { rows } = await pool.query('select source_csv from imports where id = $1', [job.id])
    expect(rows[0].source_csv).toBeNull()
  })

  test('F05-E8 double click on upload starts one import', async ({ page }) => {
    const name = `Once ${uid()}`
    await page.goto(`/projects/${projectId}/import`)
    await page.getByLabel('Campaign name').fill(name)
    await page.getByLabel('CSV file').setInputFiles({ name: 'l.csv', mimeType: 'text/csv', buffer: Buffer.from(toCsv(someLeads(1))) })
    await page.getByRole('button', { name: 'Upload' }).dblclick()
    await expect(page.getByText('1 lead ready for review')).toBeVisible({ timeout: 15_000 })
    const { rows } = await pool.query('select count(*)::int as n from imports where name = $1', [name])
    expect(rows[0].n).toBe(1)
  })

  test('F05-E9 a one-lead result reads correctly', async ({ page }) => {
    const job = await upload(page, projectId, toCsv(someLeads(1)))
    await page.goto(`/projects/${projectId}/imports/${job.id}`)
    await expect(page.getByText('1 lead ready for review')).toBeVisible()
  })

  test('F05-N1 unusable files are refused with a reason', async ({ page }) => {
    expect((await upload(page, projectId, '')).message).toMatch(/no rows/)
    expect((await upload(page, projectId, 'email,first_name\n')).message).toMatch(/no rows/)
    expect((await upload(page, projectId, 'name,phone\nAna,123\n')).message).toMatch(/email/)
    const binary = await upload(page, projectId, Buffer.from([0, 255, 1, 2, 3, 10, 200, 201, 34, 10]))
    expect(binary.status).toBe(422)
  })

  test('F05-N2 more than 30,000 rows is refused', async ({ page }) => {
    const rows = Array.from({ length: 30_001 }, (_, i) => `x${i}@clinic.test,A`).join('\n')
    const job = await upload(page, projectId, `email,first_name\n${rows}\n`)
    expect(job.status).toBe(422)
    expect(job.message).toContain('30,000')
  })

  test('F05-N3 an import where nobody qualifies makes no campaign', async ({ page }) => {
    const job = await upload(page, projectId, 'email,first_name\nbad,Ana\n')
    expect(job.campaignId).toBeNull()
    expect((await api(page, 'GET', `/api/campaigns?project_id=${projectId}`)).json).toEqual([])
  })
})
