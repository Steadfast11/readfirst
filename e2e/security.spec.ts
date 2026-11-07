import { api, conversation, expect, login, test, uid } from './helpers'

test('SEC-1 a second user reaches nothing that belongs to the first', async ({ page, browser }) => {
  await login(page)
  const c = await conversation(page)
  const job = (await api(page, 'GET', `/api/campaigns?project_id=${c.projectId}`)).json
  expect(job).toHaveLength(1)
  const list = (await api(page, 'POST', '/api/suppression', { name: `S${uid()}`, entries: 'a@b.test' })).json

  const context = await browser.newContext({ baseURL: 'http://localhost:3000' })
  const other = await context.newPage()
  await login(other)
  const calls: [string, string, unknown?][] = [
    ['GET', `/api/projects/${c.projectId}`],
    ['PATCH', `/api/projects/${c.projectId}`, { sender_name: 'x' }],
    ['GET', `/api/projects/${c.projectId}/inbox`],
    ['PATCH', `/api/mailboxes/${c.mailboxId}`, { daily_limit: 1 }],
    ['DELETE', `/api/mailboxes/${c.mailboxId}`],
    ['POST', `/api/mailboxes/${c.mailboxId}/test`],
    ['POST', `/api/mailboxes/${c.mailboxId}/check-dns`],
    ['GET', `/api/campaigns/${c.campaignId}`],
    ['PATCH', `/api/campaigns/${c.campaignId}`, { name: 'x' }],
    ['POST', `/api/campaigns/${c.campaignId}/approve`],
    ['POST', `/api/campaigns/${c.campaignId}/stop`],
    ['POST', `/api/campaigns/${c.campaignId}/start`],
    ['POST', `/api/campaigns/${c.campaignId}/archive`],
    ['GET', `/api/campaigns/${c.campaignId}/status`],
    ['GET', `/api/campaigns/${c.campaignId}/leads`],
    ['PATCH', `/api/campaigns/${c.campaignId}/leads/${c.leadId}`, { stage: 'excluded' }],
    ['GET', `/api/campaigns/${c.campaignId}/first-email`],
    ['PATCH', `/api/campaigns/${c.campaignId}/first-email`, { subject: 'x' }],
    ['GET', `/api/campaigns/${c.campaignId}/preview`],
    ['GET', `/api/imports/${c.job.id}`],
    ['GET', `/api/imports/${c.job.id}/rows`],
    ['GET', `/api/leads/${c.leadId}/thread`],
    ['POST', `/api/leads/${c.leadId}/reply`, { body: 'x' }],
    ['PATCH', `/api/leads/${c.leadId}`, { note: 'x' }],
    ['POST', `/api/leads/${c.leadId}/mark-replied`],
    ['GET', `/api/suppression/${list.id}`],
    ['DELETE', `/api/suppression/${list.id}`],
    ['POST', '/api/mailboxes', { project_id: c.projectId, email: 'x@y.test', smtp_host: 'h', imap_host: 'h', username: 'u', password: 'p' }],
    ['POST', '/api/campaigns', { project_id: c.projectId, name: 'x' }],
  ]
  for (const [method, url, data] of calls) {
    expect((await api(other, method, url, data)).status, `${method} ${url}`).toBe(404)
  }
  expect((await api(other, 'GET', `/api/mailboxes?project_id=${c.projectId}`)).json).toEqual([])
  expect((await api(other, 'GET', `/api/campaigns?project_id=${c.projectId}`)).json).toEqual([])
  await context.close()

  expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}`)).json.name).toBe('List')
})

test('SEC-2 nothing works signed out', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:3000' })
  const page = await context.newPage()
  for (const url of ['/api/projects', '/api/suppression', '/api/mailboxes?project_id=x']) {
    expect((await page.request.get(url)).status(), url).toBe(401)
  }
  expect((await page.request.post('/api/projects', { data: { domain: 'a.test' } })).status()).toBe(401)
  await page.goto('/projects')
  await expect(page).toHaveURL(/login/)
  await context.close()
})

test('SEC-3 unknown fields are refused, not ignored', async ({ page }) => {
  await login(page)
  const c = await conversation(page)
  expect((await api(page, 'PATCH', `/api/campaigns/${c.campaignId}`, { status: 'sending' })).status).toBe(422)
  expect((await api(page, 'PATCH', `/api/projects/${c.projectId}`, { org_id: c.projectId })).status).toBe(422)
})
