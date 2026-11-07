// Opens the packaged app on this machine and walks it through its window. Sends no email.
const { chromium } = require('@playwright/test')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dist = path.join(__dirname, 'dist')
const find = () => {
  if (process.platform === 'win32') return path.join(dist, 'win-unpacked/Readfirst.exe')
  if (process.platform === 'linux') return path.join(dist, 'linux-unpacked/readfirst-desktop')
  const dir = fs.readdirSync(dist).find((d) => d.startsWith('mac'))
  return path.join(dist, dir, 'Readfirst.app/Contents/MacOS/Readfirst')
}
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'readfirst-smoke-'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const check = (ok, label) => {
  if (!ok) throw new Error(label)
  console.log('ok:', label)
}

async function launch() {
  const env = { ...process.env, READFIRST_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const args = ['--remote-debugging-port=9333', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
  const child = spawn(find(), args, { env, stdio: 'ignore' })
  let browser = null
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(1000)
    browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 8000 }).catch(() => null)
  }
  if (!browser) throw new Error('The window never opened')
  for (let i = 0; i < 360; i++) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/projects'))
    if (page) return { child, browser, page }
    await sleep(500)
  }
  throw new Error('The app never reached the projects page')
}

async function close({ child, browser }) {
  child.kill()
  await sleep(5000)
  await browser.close().catch(() => {})
}

const call = (page, url, init) => page.evaluate(async ([u, i]) => (await fetch(u, i)).json(), [url, init])

async function main() {
  let app = await launch()
  await app.page.waitForSelector('h1')
  check((await app.page.locator('h1').first().innerText()) === 'Projects', 'opens with no sign-in')

  const project = await call(app.page, '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'smoke-test.example' }) })
  const id = await app.page.evaluate(async (projectId) => {
    const form = new FormData()
    form.set('project_id', projectId)
    form.set('name', 'Smoke')
    form.set('file', new Blob(['email,first_name\nana@smoke-test.example,Ana\n'], { type: 'text/csv' }), 'leads.csv')
    return (await (await fetch('/api/imports', { method: 'POST', body: form })).json()).id
  }, project.id)
  let status = 'pending'
  for (let i = 0; i < 60 && status === 'pending'; i++) {
    await sleep(500)
    status = (await call(app.page, `/api/imports/${id}`)).status
  }
  check(status === 'completed', 'the background worker imports a list')

  await app.page.getByRole('link', { name: 'Settings' }).first().click()
  await app.page.waitForURL('**/settings')
  await app.page.getByLabel('Model name').fill('demo-model')
  await app.page.getByLabel('Anthropic API key').fill('test-not-real')
  await app.page.getByRole('button', { name: 'Save settings' }).click()
  await sleep(9000)
  await app.page.waitForSelector('h1')
  check((await app.page.getByLabel('Model name').inputValue()) === 'demo-model', 'settings are saved')
  check((await app.page.getByLabel('Anthropic API key').inputValue()) === '', 'a saved key is not shown again')
  check((await fetch(app.page.url().replace('/settings', '/api/projects'))).status === 401, 'other programs cannot reach the API')
  const command = await app.page.locator('pre').first().innerText()
  const [, url, token] = command.match(/(http:\/\/127\.0\.0\.1:\d+\/api\/mcp) --header "Authorization: Bearer ([^"]+)"/) ?? []
  const rpc = (body) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }).then((r) => r.json())
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  check(tools.result?.tools?.length === 9, 'an AI agent can connect over MCP')
  await close(app)

  app = await launch()
  await app.page.goto(app.page.url().replace('/projects', '/settings'))
  await app.page.waitForSelector('h1')
  check((await app.page.getByLabel('Model name').inputValue()) === 'demo-model', 'settings survive a restart')
  await close(app)
  process.exit(0)
}

main().catch((err) => {
  console.error('FAILED:', err.message)
  for (const name of fs.existsSync(data) ? fs.readdirSync(data).filter((f) => f.endsWith('.log')) : []) {
    console.error(`--- ${name}`)
    console.error(fs.readFileSync(path.join(data, name), 'utf8').split('\n').slice(-25).join('\n'))
  }
  process.exit(1)
})
