import { eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { getServerSession, type NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import { db, t } from '@/db'

export type SessionUser = { userId: string; orgId: string; role: string }

export const devLoginEnabled = process.env.DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production'
export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)

function emailAllowed(email: string) {
  if (devLoginEnabled) return true
  const allowed = (process.env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  return allowed.includes(email.toLowerCase())
}

/** First sign-in creates the user, their organization and the default do-not-contact list. */
async function ensureUser(email: string, name?: string | null): Promise<SessionUser> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(t.users)
      .values({ email: email.toLowerCase(), name: name ?? null })
      .onConflictDoUpdate({ target: t.users.email, set: { name: name ?? null } })
      .returning()
    const [member] = await tx.select().from(t.memberships).where(eq(t.memberships.userId, user.id)).limit(1)
    if (member) return { userId: user.id, orgId: member.orgId, role: member.role }
    const [org] = await tx.insert(t.organizations).values({ name: name || email }).returning()
    await tx.insert(t.memberships).values({ orgId: org.id, userId: user.id, role: 'owner' })
    await tx.insert(t.suppressionLists).values({ orgId: org.id, name: 'Unsubscribed' })
    return { userId: user.id, orgId: org.id, role: 'owner' }
  })
}

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    ...(googleEnabled
      ? [GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! })]
      : []),
    ...(devLoginEnabled
      ? [
          CredentialsProvider({
            id: 'dev',
            name: 'Local test login',
            credentials: { email: { type: 'email' } },
            authorize: async (c) => (c?.email ? { id: c.email, email: c.email, name: 'Local tester' } : null),
          }),
        ]
      : []),
  ],
  callbacks: {
    signIn: ({ user }) => Boolean(user.email && emailAllowed(user.email)),
    jwt: async ({ token, user }) => {
      if (user?.email) Object.assign(token, await ensureUser(user.email, user.name))
      return token
    },
    session: ({ session, token }) => Object.assign(session, { app: token }),
  },
}

const globals = globalThis as unknown as { desktopUser?: Promise<SessionUser> }

/** True when running inside the desktop app, which has one local owner and no sign-in. */
export const isDesktop = () => Boolean(process.env.DESKTOP_TOKEN)

/** The one owner of a desktop install, also the account an AI agent works for over MCP. */
export const localOwner = () => (globals.desktopUser ??= ensureUser(process.env.MCP_EMAIL ?? 'owner@readfirst.local', 'Owner'))

export async function currentUser(): Promise<SessionUser | null> {
  if (isDesktop()) {
    // The app window holds this cookie. A web page in the person's browser does not, so it cannot reach the API.
    if ((await cookies()).get('desktop_token')?.value !== process.env.DESKTOP_TOKEN) return null
    return localOwner()
  }
  const session = await getServerSession(authOptions)
  const app = (session as unknown as { app?: Partial<SessionUser> } | null)?.app
  if (!app?.userId || !app.orgId || !app.role) return null
  return { userId: app.userId, orgId: app.orgId, role: app.role }
}
