import { LinkButton } from '@/components/ui'

export default function NotFound() {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-2 text-lg">We could not find this page</h1>
      <p className="mb-4 text-muted">It may have been removed, or the link may be wrong.</p>
      <LinkButton href="/projects">Back to projects</LinkButton>
    </main>
  )
}
