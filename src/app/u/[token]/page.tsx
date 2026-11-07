import { buttonClass } from '@/components/ui'
import { leadByToken } from '@/server/suppression'

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ done?: string }>
}) {
  const { token } = await params
  const { done } = await searchParams
  const lead = await leadByToken(token)
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      {!lead ? (
        <p>This link is no longer valid.</p>
      ) : done ? (
        <>
          <h1 className="mb-2 text-lg">You are unsubscribed</h1>
          <p className="text-muted">You will not hear from us again.</p>
        </>
      ) : (
        <form method="post" action={`/u/${token}/confirm`}>
          <h1 className="mb-2 text-lg">Stop these emails?</h1>
          <p className="mb-4 text-muted">One click and we will not contact you again.</p>
          <button type="submit" className={buttonClass('primary')}>Unsubscribe</button>
        </form>
      )}
    </main>
  )
}
