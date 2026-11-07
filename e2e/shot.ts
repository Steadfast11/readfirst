import { chromium } from '@playwright/test'

// Makes the landing page's product image from made-up demo data. Run by hand; it sends nothing.
const base = 'http://localhost:3000'
const people = [
  ['ana@clinic-one.test', 'Ana', 'Moreira', 'Clinica Sorriso', 'Owner'],
  ['tomas@clinic-two.test', 'Tomás', 'Vidal', 'Porto Dental', 'Practice manager'],
  ['eva@clinic-three.test', 'Eva', 'Costa', 'Clínica Atlântico', 'Owner'],
  ['rui@clinic-four.test', 'Rui', 'Lopes', 'Dente Claro', 'Co-owner'],
]

async function main() {
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 720 } })).newPage()
  await page.goto('/login')
  await page.getByLabel('Local test email').fill(`demo${Date.now()}@example.test`)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/projects')
  const post = (url: string, data: unknown, method = 'POST') => page.request.fetch(url, { method, data: data as never }).then((r) => r.json())
  const project = await post('/api/projects', { domain: `sorrisobooking${Date.now()}.test` })
  await post(`/api/projects/${project.id}`, { sender_name: 'Sam Rivers', legal_footer: 'Example Ltd, 1 Test Road', legal_basis_confirmed: true }, 'PATCH')
  const box = await post('/api/mailboxes', { project_id: project.id, email: `sam${Date.now()}@example.test`, smtp_host: 'localhost', smtp_port: 1025, imap_host: 'localhost', imap_port: 1143, username: 'testuser', password: 'testpass' })
  await page.request.post(`/api/mailboxes/${box.id}/test`)
  const csv = ['email,first_name,last_name,company,title', ...people.map((p) => p.join(','))].join('\n')
  const job = await (await page.request.post('/api/imports', { multipart: { project_id: project.id, name: 'Dental clinics in Portugal', file: { name: 'l.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } })).json()
  let state = { status: 'pending', campaignId: '' }
  while (state.status === 'pending') {
    await page.waitForTimeout(200)
    state = await (await page.request.get(`/api/imports/${job.id}`)).json()
  }
  await post(`/api/campaigns/${state.campaignId}/first-email`, { subject: 'Bookings at {{company}}', body: 'Hi {{first_name}},\n\nHow do people book with you today?' }, 'PATCH')
  await page.goto(`/projects/${project.id}/campaigns/${state.campaignId}`)
  await page.getByRole('button', { name: /Approve 4 leads/ }).waitFor()
  await page.screenshot({ path: 'public/product.png' })
  await browser.close()
}

main()
