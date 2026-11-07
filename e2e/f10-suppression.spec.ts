import { api, approve, campaign, expect, leadsOf, login, mailTo, pool, someLeads, test, tick, toCsv, uid, upload } from './helpers'

const tokenOf = async (campaignId: string) =>
  (await pool.query('select unsubscribe_token as t from leads where campaign_id = $1 limit 1', [campaignId])).rows[0].t as string

test.describe('F10 opt-outs', () => {
  test.beforeEach(async ({ page }) => void (await login(page)))

  test('F10-E1 opening the link alone unsubscribes nobody', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    await page.goto(`/u/${await tokenOf(c.campaignId)}`)
    expect((await leadsOf(page, c.campaignId))[0].contact.unsubscribedAt).toBeNull()
  })

  test('F10-E2 a bad token shows a clear page and changes nothing', async ({ page }) => {
    await page.goto('/u/not-a-real-token')
    await expect(page.getByText('This link is no longer valid.')).toBeVisible()
    expect((await page.request.post('/u/not-a-real-token/confirm')).status()).toBe(404)
  })

  test('F10-E3 the opt-out list cannot be deleted', async ({ page }) => {
    const lists = (await api(page, 'GET', '/api/suppression')).json as { id: string; name: string }[]
    const optOuts = lists.find((l) => l.name === 'Unsubscribed')!
    expect((await api(page, 'DELETE', `/api/suppression/${optOuts.id}`)).status).toBe(409)
  })

  test('F10-E4 a domain entry blocks the company, ignoring case', async ({ page }) => {
    const id = uid()
    await api(page, 'POST', '/api/suppression', { name: 'Co', entries: `BLOCKED${id}.TEST` })
    const c = await campaign(page, someLeads(1))
    const job = await upload(page, c.projectId, toCsv([{ email: `x@blocked${id}.test` }]))
    expect(job.totals[0].reason).toBe('suppressed')
  })

  test('F10-E5 duplicate and junk lists are refused', async ({ page }) => {
    const name = `L${uid()}`
    expect((await api(page, 'POST', '/api/suppression', { name, entries: 'a@b.test' })).status).toBe(200)
    expect((await api(page, 'POST', '/api/suppression', { name, entries: 'c@d.test' })).status).toBe(409)
    expect((await api(page, 'POST', '/api/suppression', { name: `${name}x`, entries: '!!! ???' })).status).toBe(422)
  })

  test('F10-E6 unsubscribing stops mail still in the queue', async ({ page }) => {
    const leads = someLeads(1)
    const c = await campaign(page, leads)
    await approve(page, c.campaignId)
    await page.request.post(`/u/${await tokenOf(c.campaignId)}/confirm`)
    expect((await tick()).sent).toBe(0)
    expect(await mailTo(leads[0].email)).toHaveLength(0)
  })

  test('F10-E7 unsubscribing twice is harmless', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    const token = await tokenOf(c.campaignId)
    expect((await page.request.post(`/u/${token}/confirm`)).status()).toBe(200)
    expect((await page.request.post(`/u/${token}/confirm`)).status()).toBe(200)
    const lists = (await api(page, 'GET', '/api/suppression')).json as { name: string; total: number }[]
    expect(lists.find((l) => l.name === 'Unsubscribed')!.total).toBe(1)
  })

  test('F10-E8 someone who unsubscribed cannot be imported again', async ({ page }) => {
    const leads = someLeads(1)
    const c = await campaign(page, leads)
    await page.request.post(`/u/${await tokenOf(c.campaignId)}/confirm`)
    const job = await upload(page, c.projectId, toCsv(leads))
    expect(job.totals[0].reason).toBe('suppressed')
  })

  test('F10-E9 the unsubscribe page works signed out', async ({ page, context }) => {
    const c = await campaign(page, someLeads(1))
    const token = await tokenOf(c.campaignId)
    await context.clearCookies()
    await page.goto(`/u/${token}`)
    await page.getByRole('button', { name: 'Unsubscribe' }).click()
    await expect(page.getByText('You are unsubscribed')).toBeVisible()
  })
})
