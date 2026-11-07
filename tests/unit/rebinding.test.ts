import dns from 'node:dns'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The first answer looks public. What the connection then gets is up to each test.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }))

import { fetchPublic, guardedLookup, isPrivateAddress } from '@/server/site'

const answer = (address: string, family = 4) =>
  vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _opts: unknown, cb: (e: null, a: unknown) => void) =>
    cb(null, [{ address, family }])) as never)

describe('DNS rebinding', () => {
  let server: http.Server
  let port: number
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('internal secret'))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => void server.close())
  afterEach(() => void vi.restoreAllMocks())

  it('refuses a host that changes to a private address after the check', async () => {
    answer('127.0.0.1')
    await expect(fetchPublic(`http://rebind.test:${port}/`)).rejects.toThrow()
  })

  it('checks every address the connection could use', () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) =>
      cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])) as never)
    const done = vi.fn()
    guardedLookup('mixed.test', { all: true }, done)
    expect(done.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('passes public answers on in the shape the caller asked for', () => {
    answer('8.8.8.8')
    const all = vi.fn()
    guardedLookup('ok.test', { all: true }, all)
    expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
    const one = vi.fn()
    guardedLookup('ok.test', {}, one)
    expect(one).toHaveBeenCalledWith(null, '8.8.8.8', 4)
  })
})

describe('address forms', () => {
  it('sees private addresses in every spelling a URL can produce', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '2001:db8::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    expect(isPrivateAddress('::ffff:808:808')).toBe(false)
  })
})
