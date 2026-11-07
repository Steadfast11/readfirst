import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { agentTick, api, approve, campaign, expect, headerOf, leadsOf, login, mailTo, pool, replyFrom, someLeads, test } from './helpers'

// The MCP endpoint works for the local owner, the same account the desktop app signs in as.
const OWNER = 'owner@readfirst.local'
const URL_ = 'http://localhost:3000/api/mcp'

async function agent(token = 'local-test-token') {
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = res.content[0].text
    let data: unknown = text
    try { data = JSON.parse(text) } catch {}
    return { error: Boolean(res.isError), data: data as Record<string, any> }
  }
  return { client, call }
}

test.describe('AI agent over MCP', () => {
  test('M1 no token, or a wrong one, is refused', async () => {
    expect((await fetch(URL_, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(URL_, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  test('M2 the agent lists its tools and gets the working instructions', async () => {
    const { client } = await agent()
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(['get_business', 'list_emails_to_write', 'list_replies_to_sort', 'list_samples_to_write', 'readfirst_overview', 'save_business_analysis', 'save_email', 'save_samples', 'sort_reply'])
    expect(client.getInstructions()).toContain('You cannot send anything')
    await client.close()
  })

  test('M3 the agent writes an approved email, the app sends it, and the agent sorts the reply', async ({ page }) => {
    await login(page, OWNER)
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await api(page, 'PATCH', `/api/campaigns/${c.campaignId}/first-email`, { mode: 'instructions', instructions: 'Ask how they book.' })

    const { client, call } = await agent()
    const samples = await call('list_samples_to_write', { project_id: c.projectId })
    const todo = samples.data.campaigns.find((x: { campaign_id: string }) => x.campaign_id === c.campaignId)
    expect(todo.leads[0].to).toBe(lead.email)
    expect((await call('save_samples', { campaign_id: c.campaignId, samples: [{ to: 'stranger@else.test', subject: 'Hi', body: 'Hello' }] })).error).toBe(true)
    expect((await call('save_samples', { campaign_id: c.campaignId, samples: [{ to: lead.email, subject: 'Bookings', body: 'Hi Lead0, how do you take bookings?' }] })).error).toBe(false)
    expect((await approve(page, c.campaignId)).status).toBe(200)

    const overview = await call('readfirst_overview')
    expect(overview.data.projects.find((p: { id: string }) => p.id === c.projectId).emails_to_write).toBe(1)
    const list = await call('list_emails_to_write', { project_id: c.projectId })
    expect(list.data.rules).toContain('cold emails')
    const [email] = list.data.emails
    expect(email.lead).toContain(lead.first_name)

    expect((await call('save_email', { message_id: email.message_id, subject: 'Bookings', body: 'Visit https://evil.test now' })).error).toBe(true)
    expect((await call('save_email', { message_id: email.message_id, subject: 'Bookings at your clinic', body: 'Hi Lead0, how do you take bookings today?' })).error).toBe(false)
    expect((await call('save_email', { message_id: email.message_id, subject: 'Again', body: 'Twice' })).error).toBe(true)

    expect((await agentTick()).sent).toBe(1)
    const [sent] = await mailTo(lead.email)
    expect(sent).toContain('how do you take bookings today?')

    await replyFrom(lead.email, c.sender, headerOf(sent, 'Message-ID'), 'Sounds good, tell me more.')
    await agentTick()
    const replies = await call('list_replies_to_sort', { project_id: c.projectId })
    expect(replies.data.replies).toHaveLength(1)
    await call('sort_reply', { message_id: replies.data.replies[0].message_id, intent: 'interested', confidence: 0.9, reason: 'Asked for more.' })
    const { rows } = await pool.query(`select why_hot from leads where id = $1`, [(await leadsOf(page, c.campaignId))[0].lead.id])
    expect(rows[0].why_hot).toBe('Asked for more.')
    await client.close()
  })

  test('M4 the agent cannot reach another account', async ({ page }) => {
    await login(page)
    const other = await campaign(page, someLeads(1))
    const { client, call } = await agent()
    expect((await call('get_business', { project_id: other.projectId })).error).toBe(true)
    const overview = await call('readfirst_overview')
    expect(overview.data.projects.some((p: { id: string }) => p.id === other.projectId)).toBe(false)
    await client.close()
  })
})
