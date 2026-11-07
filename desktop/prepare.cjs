// Puts the built web app and the worker in dist-app, ready to be packaged.
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const out = path.join(__dirname, 'dist-app')
const run = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })

fs.rmSync(out, { recursive: true, force: true })
run('npx next build', { DESKTOP_BUILD: '1' })
fs.cpSync(path.join(root, '.next/standalone'), out, { recursive: true, dereference: true })
fs.cpSync(path.join(root, '.next/static'), path.join(out, '.next/static'), { recursive: true })
fs.cpSync(path.join(root, 'public'), path.join(out, 'public'), { recursive: true })
for (const secret of ['.env', '.env.local']) fs.rmSync(path.join(out, secret), { force: true })
run(`npx esbuild src/worker/index.ts --bundle --platform=node --target=node20 --format=cjs --tsconfig=tsconfig.json --outfile="${path.join(out, 'worker.cjs')}"`)
