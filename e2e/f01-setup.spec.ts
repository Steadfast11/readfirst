import { randomUUID } from 'node:crypto'
import { simpleParser } from 'mailparser'
import { alertWith, api, approve, campaign, expect, login, mailTo, newProject, pool, someLeads, test, tick, uid } from './helpers'

test.describe('F01 setup', () => {
  test.beforeEach(async ({ page }) => void (await login(page)))

  test('F01-E1 a domain with spaces is refused', async ({ page }) => {
    const res = await api(page, 'POST', '/api/projects', { domain: `foo bar${uid()}.test` })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('F01-E3 an unknown project URL is a clean 404', async ({ page }) => {
    const missing = await page.goto(`/projects/${randomUUID()}`)
    expect(missing?.status()).toBe(404)
    const bad = await page.goto('/projects/not-a-uuid')
    expect(bad?.status()).toBe(404)
  })

  test('F01-E4 an empty settings update is not a server error', async ({ page }) => {
    const { projectId } = await newProject(page)
    expect((await api(page, 'PATCH', `/api/projects/${projectId}`, {})).status).toBe(200)
  })

  test('F01-E5 a dead mail server fails the mailbox and keeps the email queued', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    await approve(page, c.campaignId)
    await pool.query('update mailboxes set smtp_port = 1 where id = $1', [c.mailboxId])
    await tick()
    const { rows } = await pool.query(
      `select m.status, b.status as box from messages m join leads l on l.id = m.lead_id join mailboxes b on b.id = $1 where l.campaign_id = $2`,
      [c.mailboxId, c.campaignId],
    )
    expect(rows[0]).toEqual({ status: 'queued', box: 'failing' })
    await pool.query(`update mailboxes set smtp_port = 1025, status = 'active' where id = $1`, [c.mailboxId])
    expect((await tick()).sent).toBe(1)
  })

  test('F01-E6 accents and emoji survive in the sender name', async ({ page }) => {
    const leads = someLeads(1)
    const c = await campaign(page, leads)
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { sender_name: 'José 🦎 Núñez' })
    await approve(page, c.campaignId)
    await tick()
    const [raw] = await mailTo(leads[0].email)
    const parsed = await simpleParser(raw)
    expect(parsed.from?.value[0].name).toBe('José 🦎 Núñez')
  })

  test('F01-E7 an expired session gives a clear message, not a crash', async ({ page, context }) => {
    const { projectId } = await newProject(page)
    await page.goto(`/projects/${projectId}/settings`)
    await context.clearCookies()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(alertWith(page, 'Please sign in.')).toBeVisible()
    await page.reload()
    await expect(page).toHaveURL(/login/)
  })

  test('F01-N1 an invalid time zone is refused with a clear message', async ({ page }) => {
    const { projectId } = await newProject(page)
    await page.goto(`/projects/${projectId}/settings`)
    await page.getByLabel('Time zone').fill('Mars/Olympus')
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(alertWith(page, 'Asia/Tashkent')).toBeVisible()
  })

  test('F01-N2 the same website twice is refused', async ({ page }) => {
    const domain = `dup${uid()}.test`
    expect((await api(page, 'POST', '/api/projects', { domain })).status).toBe(200)
    const again = await api(page, 'POST', '/api/projects', { domain: `https://www.${domain}/x` })
    expect(again.status).toBe(409)
  })

  test('F01-N3 DNS check handles a domain with no records', async ({ page }) => {
    const { mailboxId } = await newProject(page)
    const res = await api(page, 'POST', `/api/mailboxes/${mailboxId}/check-dns`)
    expect(res.status).toBe(200)
    expect(res.json.spfOk).toBe(false)
  })

  test('F01-N4 a stored mailbox password is encrypted and never returned', async ({ page }) => {
    const { mailboxId, projectId } = await newProject(page)
    const { rows } = await pool.query('select secret_enc from mailboxes where id = $1', [mailboxId])
    expect(rows[0].secret_enc).not.toContain('testpass')
    expect(JSON.stringify((await api(page, 'GET', `/api/mailboxes?project_id=${projectId}`)).json)).not.toMatch(/secret|testpass/i)
  })
})
