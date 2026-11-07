import { PgBoss } from 'pg-boss'

export const EVENT_QUEUES = ['run-import', 'analyse-project', 'draft-campaign', 'find-leads'] as const
export const QUEUES = [...EVENT_QUEUES, 'send-tick', 'poll-mailbox', 'reap-stuck', 'agent-tick', 'check-mailboxes'] as const

const globals = globalThis as unknown as { boss?: Promise<PgBoss> }

/** The web process only adds jobs, so it runs no maintenance or schedules. */
function publisher() {
  return (globals.boss ??= (async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, supervise: false, schedule: false })
    boss.on('error', console.error)
    await boss.start()
    for (const queue of EVENT_QUEUES) await boss.createQueue(queue)
    return boss
  })())
}

export async function enqueue(queue: (typeof EVENT_QUEUES)[number], id: string) {
  const boss = await publisher()
  await boss.send(queue, { id })
}

export const enqueueImport = (id: string) => enqueue('run-import', id)
