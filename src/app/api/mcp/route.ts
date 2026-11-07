import { timingSafeEqual } from 'node:crypto'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { localOwner } from '@/server/auth'
import { buildMcpServer } from '@/server/mcp'

export const dynamic = 'force-dynamic'

function authorised(req: Request) {
  const expected = process.env.MCP_TOKEN
  if (!expected) return false
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** AI agents connect here over MCP. Off unless MCP_TOKEN is set; the desktop app sets it. */
async function handle(req: Request) {
  if (!process.env.MCP_TOKEN) return new Response('MCP is not enabled.', { status: 404 })
  if (!authorised(req)) return new Response('A valid bearer token is required.', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
  const server = buildMcpServer(await localOwner())
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(req)
}

export const POST = handle
export const GET = handle
export const DELETE = handle
