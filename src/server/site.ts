import dns, { type LookupAddress, type LookupOptions } from 'node:dns'
import { lookup } from 'node:dns/promises'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { aiFake } from './ai'

const MAX_BYTES = 500_000
const TIMEOUT_MS = 8000
const AGENT = 'OutreachSiteReader/1.0'

const blocked = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6')

/** True for addresses a server must never be pointed at. BlockList also reads IPv4 written as IPv6. */
export function isPrivateAddress(ip: string) {
  const family = isIP(ip)
  if (!family) return true
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/** Returns a public address for a host, or throws. Connect to this address, not the name. */
export async function resolvePublicHost(host: string) {
  const name = host.replace(/^\[|\]$/g, '')
  if (isIP(name)) {
    if (isPrivateAddress(name)) throw new Error('private address')
    return name
  }
  if (/(^|\.)(localhost|local|internal)$/i.test(name)) throw new Error('private address')
  const found = await lookup(name, { all: true })
  if (!found.length || found.some((a) => isPrivateAddress(a.address))) throw new Error('private address')
  return found[0].address
}

export const assertPublicHost = async (host: string) => void (await resolvePublicHost(host))

type LookupDone = (err: Error | null, address?: string | LookupAddress[], family?: number) => void

/**
 * Runs at connect time, on the answer the socket will really use. A check made earlier
 * is not enough: a hostile DNS server can answer differently the second time.
 */
export function guardedLookup(hostname: string, options: LookupOptions, done: LookupDone) {
  dns.lookup(hostname, { ...options, all: true }, (err, found) => {
    if (err) return done(err)
    if (!found.length || found.some((a) => isPrivateAddress(a.address))) return done(new Error('private address'))
    if (options.all) return done(null, found)
    done(null, found[0].address, found[0].family)
  })
}

function open(url: URL) {
  const client = url.protocol === 'https:' ? https : http
  return new Promise<IncomingMessage>((resolve, reject) => {
    client
      .get(url, {
        lookup: guardedLookup as never,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': AGENT, accept: 'text/html,text/plain' },
      }, resolve)
      .on('error', reject)
  })
}

export async function fetchPublic(start: string) {
  let url = new URL(start)
  for (let hop = 0; hop < 4; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad scheme')
    await assertPublicHost(url.hostname)
    const res = await open(url)
    const status = res.statusCode ?? 0
    const next = res.headers.location
    if (status >= 300 && status < 400 && next) {
      res.destroy()
      url = new URL(next, url)
      continue
    }
    return res
  }
  throw new Error('too many redirects')
}

const isOk = (res: IncomingMessage) => (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300

async function readCapped(res: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res) {
    chunks.push(chunk as Buffer)
    size += (chunk as Buffer).length
    if (size >= MAX_BYTES) break
  }
  res.destroy()
  return Buffer.concat(chunks).toString('utf8')
}

export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** Paths a robots.txt forbids for every crawler. A rule for our own agent is not expected. */
export function robotsDisallows(robots: string, path: string) {
  let applies = false
  const rules: string[] = []
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim()
    const [key, ...rest] = line.split(':')
    const value = rest.join(':').trim()
    if (/^user-agent$/i.test(key)) applies = value === '*'
    else if (applies && /^disallow$/i.test(key) && value) rules.push(value)
  }
  return rules.some((rule) => path.startsWith(rule))
}

async function allowed(origin: string, path: string) {
  try {
    const res = await fetchPublic(`${origin}/robots.txt`)
    if (!isOk(res)) {
      res.destroy()
      return true
    }
    return !robotsDisallows(await readCapped(res), path)
  } catch {
    return true
  }
}

/** Reads up to a few public pages of a site, as text. Empty when nothing could be read. */
export async function readSite(domain: string, paths = ['/', '/about', '/pricing']) {
  if (aiFake()) return `Fake site text for ${domain}.`
  const host = domain.trim().replace(/^https?:\/\//i, '').split('/')[0]
  const origin = `https://${host}`
  const parts: string[] = []
  for (const path of paths) {
    try {
      if (!(await allowed(origin, path))) continue
      const res = await fetchPublic(`${origin}${path}`)
      if (!isOk(res) || !/text\/(html|plain)/.test(res.headers['content-type'] ?? '')) {
        res.destroy()
        continue
      }
      parts.push(htmlToText(await readCapped(res)).slice(0, 6000))
    } catch {
      // A page that cannot be read is skipped.
    }
  }
  return parts.join('\n\n').trim()
}
