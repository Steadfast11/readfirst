import { ZodError } from 'zod'
import { currentUser, type SessionUser } from './auth'

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export const notFound = (what = 'Item') => new ApiError(404, 'not_found', `${what} not found.`)

type Handler<P> = (c: SessionUser & { req: Request; params: P }) => Promise<unknown>

/** Wraps a route: signed-in check, role check, JSON output, one error shape. */
export function api<P = Record<string, never>>(fn: Handler<P>, opts: { owner?: boolean } = {}) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    try {
      const user = await currentUser()
      if (!user) throw new ApiError(401, 'unauthorized', 'Please sign in.')
      if (opts.owner && user.role !== 'owner') {
        throw new ApiError(403, 'forbidden', 'Only an owner can do this.')
      }
      const result = await fn({ ...user, req, params: await ctx.params })
      if (result instanceof Response) return result
      return result === undefined ? new Response(null, { status: 204 }) : Response.json(result)
    } catch (err) {
      return errorResponse(err)
    }
  }
}

function readable(err: ZodError) {
  const first = err.issues[0]
  if (!first) return 'Invalid input.'
  const raw = String(first.path.at(-1) ?? 'value').replace(/_/g, ' ')
  const label = raw.charAt(0).toUpperCase() + raw.slice(1)
  const limit = (first as { maximum?: unknown }).maximum
  if (first.code === 'too_big') return `${label} is too long. The limit is ${limit} characters.`
  if (first.code === 'too_small') return `${label} is required.`
  return `${label}: ${first.message}`
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return Response.json({ code: err.code, message: err.message }, { status: err.status })
  }
  if (err instanceof ZodError) {
    return Response.json({ code: 'invalid', message: readable(err) }, { status: 422 })
  }
  console.error(err)
  return Response.json({ code: 'server_error', message: 'Something went wrong. Try again.' }, { status: 500 })
}

export function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}
