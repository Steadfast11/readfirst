import { describe, expect, it } from 'vitest'
import { autoReplyProblem } from '@/server/replies'
import { emailProblem } from '@/server/agent'
import { isPrivateAddress, htmlToText, robotsDisallows } from '@/server/site'
import { csvCell } from '@/server/analytics'
import { aiLines, fillAiLines, hasAiLines, renderTemplate } from '@/server/render'

describe('auto-reply guard', () => {
  const url = 'https://cal.example.com/sam'
  it('allows the booking link and nothing else', () => {
    expect(autoReplyProblem(`Pick a time: ${url}.`, url)).toBeNull()
    expect(autoReplyProblem('See https://evil.test', url)).toContain('link')
    expect(autoReplyProblem(`See ${url}/extra`, url)).toContain('link')
    expect(autoReplyProblem('See www.evil.test', null)).toContain('link')
  })
  it('stops prices and promises', () => {
    expect(autoReplyProblem('It is $99 a month', url)).toContain('price')
    expect(autoReplyProblem('Only 50 EUR', url)).toContain('price')
    expect(autoReplyProblem('We guarantee results', url)).toContain('promise')
    expect(autoReplyProblem('', url)).toContain('empty')
  })
})

describe('email guard', () => {
  it('refuses placeholders, links and empty text', () => {
    expect(emailProblem({ subject: 'Hi', body: 'Fine text' })).toBeNull()
    expect(emailProblem({ subject: 'Hi [name]', body: 'x' })).toContain('placeholder')
    expect(emailProblem({ subject: 'Hi', body: 'Hello {{company}}' })).toContain('placeholder')
    expect(emailProblem({ subject: 'Hi', body: 'See https://a.test' })).toContain('link')
    expect(emailProblem({ subject: '', body: 'x' })).toContain('empty')
  })
})

describe('private addresses', () => {
  it('blocks what a server must not reach', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false)
  })
})

describe('site text', () => {
  it('drops scripts and tags', () => {
    expect(htmlToText('<p>Hello &amp; welcome</p><script>evil()</script><style>a{}</style>')).toBe('Hello & welcome')
  })
  it('reads robots rules for all crawlers', () => {
    const robots = 'User-agent: *\nDisallow: /private\n\nUser-agent: Other\nDisallow: /'
    expect(robotsDisallows(robots, '/private/x')).toBe(true)
    expect(robotsDisallows(robots, '/about')).toBe(false)
  })
})

describe('csv cells', () => {
  it('neutralises formulas and quotes separators', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell(null)).toBe('')
  })
})

describe('variations and AI lines', () => {
  it('picks the same option for the same seed', () => {
    const a = renderTemplate('{Hi|Hello|Hey} {{first_name}}', { first_name: 'Ana' }, 'lead-1').text
    expect(a).toBe(renderTemplate('{Hi|Hello|Hey} {{first_name}}', { first_name: 'Ana' }, 'lead-1').text)
    expect(a).toMatch(/^(Hi|Hello|Hey) Ana$/)
  })
  it('leaves a fallback alone', () => {
    expect(renderTemplate('{{first_name|there}}', {}).text).toBe('there')
  })
  it('finds and fills AI lines', () => {
    const text = 'A {{ai: one}} B {{ ai: two }}'
    expect(hasAiLines(text)).toBe(true)
    expect(aiLines(text)).toEqual(['one', 'two'])
    expect(fillAiLines(text, ['1', '2'])).toBe('A 1 B 2')
  })
})
