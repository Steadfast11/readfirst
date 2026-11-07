const { app, BrowserWindow, dialog, nativeTheme, safeStorage, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

// Automated smoke tests point the app at a throwaway folder.
if (process.env.READFIRST_DATA) app.setPath('userData', process.env.READFIRST_DATA)
fs.mkdirSync(app.getPath('userData'), { recursive: true })

const resources = app.isPackaged ? process.resourcesPath : __dirname
const appDir = path.join(resources, app.isPackaged ? 'web' : 'dist-app')
const migrationsDir = app.isPackaged ? path.join(resources, 'migrations') : path.join(__dirname, '../db/migrations')

let win = null
let postgres = null
let quitting = false
let config = null
const children = {}

const dataPath = (...parts) => path.join(app.getPath('userData'), ...parts)

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Secrets made on first run, held in the operating system's keychain where it offers one. */
function loadKeys() {
  const file = dataPath('keys.bin')
  const secure = safeStorage.isEncryptionAvailable()
  const saved = fs.existsSync(file) ? JSON.parse(secure ? safeStorage.decryptString(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8')) : {}
  const keys = {
    mailboxKey: crypto.randomBytes(32).toString('base64'),
    authSecret: crypto.randomBytes(32).toString('base64'),
    dbPassword: crypto.randomBytes(24).toString('hex'),
    mcpToken: crypto.randomBytes(24).toString('base64url'),
    ...saved,
  }
  saveKeys(keys)
  return keys
}

function saveKeys(keys) {
  const text = JSON.stringify(keys)
  const secure = safeStorage.isEncryptionAvailable()
  fs.writeFileSync(dataPath('keys.bin'), secure ? safeStorage.encryptString(text) : text, { mode: 0o600 })
}

/** An AI agent is set up once with this address, so the port stays the same between runs when it can. */
async function stablePort(keys) {
  const free = (port) => new Promise((done) => {
    const server = net.createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
  if (keys.port && (await free(keys.port))) return keys.port
  for (const port of [47210, 47211, 47212, 47213]) {
    if (await free(port)) {
      keys.port = port
      saveKeys(keys)
      return port
    }
  }
  return freePort()
}

/** Same format as encryptSecret in src/server/render.ts. */
function readSettings(mailboxKey) {
  const file = dataPath('settings.enc')
  if (!fs.existsSync(file)) return {}
  const raw = Buffer.from(fs.readFileSync(file, 'utf8'), 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(mailboxKey, 'base64'), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'))
}

async function startDatabase(password) {
  // Postgres on macOS refuses to start without a valid locale.
  if (process.platform === 'darwin') process.env.LC_ALL = 'en_US.UTF-8'
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const dir = dataPath('database')
  const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'))
  const port = await freePort()
  const pgLog = (line) => { try { fs.appendFileSync(dataPath('postgres.log'), `${String(line).trimEnd()}\n`) } catch {} }
  postgres = new EmbeddedPostgres({ databaseDir: dir, user: 'readfirst', password, port, persistent: true, onLog: pgLog, onError: pgLog })
  const step = async (name, work) => {
    try {
      return await work()
    } catch (err) {
      throw new Error(`The database could not ${name}: ${err?.message ?? err ?? 'no reason given'}. See postgres.log in ${app.getPath('userData')}`)
    }
  }
  if (fresh) await step('be created', () => postgres.initialise())
  await step('start', () => postgres.start())
  if (fresh) await postgres.createDatabase('readfirst')
  const url = `postgres://readfirst:${password}@127.0.0.1:${port}/readfirst`
  const { Client } = require('pg')
  const client = new Client({ connectionString: url })
  await client.connect()
  await client.query('create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())')
  const { rows } = await client.query('select name from app_migrations')
  const done = new Set(rows.map((r) => r.name))
  for (const name of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue
    await client.query('begin')
    await client.query(fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
    await client.query('insert into app_migrations (name) values ($1)', [name])
    await client.query('commit')
  }
  await client.end()
  return url
}

function serviceEnv() {
  const { keys, databaseUrl, port, token } = config
  return {
    ...process.env,
    AI_AGENT: '1',
    ...readSettings(keys.mailboxKey),
    MCP_TOKEN: keys.mcpToken,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    MAILBOX_KEY: keys.mailboxKey,
    NEXTAUTH_SECRET: keys.authSecret,
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    APP_URL: `http://127.0.0.1:${port}`,
    DESKTOP_TOKEN: token,
    SETTINGS_FILE: dataPath('settings.enc'),
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
  }
}

function startService(name, script) {
  const log = fs.openSync(dataPath(`${name}.log`), 'a')
  const child = spawn(process.execPath, [path.join(appDir, script)], { cwd: appDir, env: serviceEnv(), stdio: ['ignore', log, log] })
  children[name] = child
  child.on('exit', () => {
    fs.closeSync(log)
    if (children[name] === child && !quitting) setTimeout(() => startService(name, script), 2000)
  })
}

const startServices = () => {
  startService('web', 'server.js')
  startService('worker', 'worker.cjs')
}

function stopServices() {
  const running = Object.entries(children)
  for (const [name] of running) delete children[name]
  return Promise.all(running.map(([, child]) => new Promise((done) => {
    child.once('exit', done)
    child.kill()
  })))
}

async function waitForWeb() {
  const url = `http://127.0.0.1:${config.port}/login`
  for (let i = 0; i < 240; i++) {
    const up = await new Promise((done) => {
      http.get(url, (res) => { res.resume(); done(true) }).on('error', () => done(false))
    })
    if (up) return
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('The app did not start in time.')
}

/** The page writes this file, so a change means new keys for both services. */
function watchSettings() {
  let timer = null
  fs.watch(app.getPath('userData'), (_event, name) => {
    if (name !== 'settings.enc') return
    clearTimeout(timer)
    timer = setTimeout(async () => {
      await stopServices()
      startServices()
      await waitForWeb()
      win?.reload()
    }, 400)
  })
}

function openWindow() {
  win = new BrowserWindow({ width: 1280, height: 840, minWidth: 420, minHeight: 600, title: 'Readfirst', autoHideMenuBar: true, show: true, backgroundColor: '#0d0c0b', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } } : {}) })
  win.loadURL(`data:text/html,${encodeURIComponent('<!doctype html><title>Readfirst</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0d0c0b;color:#ece8e1;font:500 12px -apple-system,system-ui,sans-serif;letter-spacing:.22em;text-transform:uppercase;-webkit-app-region:drag}span{animation:f 1.6s cubic-bezier(.32,.72,0,1) infinite alternate}@keyframes f{from{opacity:.35}}</style><body><span>Readfirst</span></body>')}`)
  const own = (url) => url.startsWith(`http://127.0.0.1:${config.port}`)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (own(url)) return
    event.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  win.on('closed', () => { win = null })
}

async function start() {
  nativeTheme.themeSource = 'dark'
  const keys = loadKeys()
  config = { keys, port: await stablePort(keys), token: crypto.randomBytes(32).toString('hex') }
  openWindow()
  config.databaseUrl = await startDatabase(keys.dbPassword)
  startServices()
  await waitForWeb()
  await session.defaultSession.cookies.set({ url: `http://127.0.0.1:${config.port}`, name: 'desktop_token', value: config.token, httpOnly: true, sameSite: 'strict' })
  // A navigation that replaces this one is fine, not a failed start.
  await win.loadURL(`http://127.0.0.1:${config.port}/projects`).catch((err) => {
    if (!String(err?.message).includes('ERR_ABORTED')) throw err
  })
  watchSettings()
}

// Ending the app from outside still stops its database and services cleanly.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit())

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (win) { win.restore(); win.focus() }
  })
  app.whenReady().then(start).catch((err) => {
    try { fs.appendFileSync(dataPath('main.log'), `${new Date().toISOString()} ${err?.stack ?? err}\n`) } catch {}
    dialog.showErrorBox('Readfirst could not start', String(err?.message ?? err))
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', async (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    await stopServices().catch(() => {})
    await postgres?.stop().catch(() => {})
    app.exit(0)
  })
}
