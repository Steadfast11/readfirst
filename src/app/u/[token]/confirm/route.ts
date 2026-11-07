import { unsubscribe } from '@/server/suppression'

/** Handles both the page button and one-click requests from mail clients. POST only. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ok = await unsubscribe(token)
  if (!ok) return new Response('This link is no longer valid.', { status: 404 })
  const isForm = req.headers.get('accept')?.includes('text/html')
  return isForm ? Response.redirect(new URL(`/u/${token}?done=1`, process.env.APP_URL ?? req.url), 303) : new Response(null, { status: 200 })
}
