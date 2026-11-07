import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { currentUser } from '@/server/auth'
import { isUuid, orNotFound } from '@/server/pages'
import { getProject } from '@/server/projects'

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await currentUser()
  if (!user || !isUuid(id)) notFound()
  await orNotFound(getProject(user.orgId, id))
  return children
}
