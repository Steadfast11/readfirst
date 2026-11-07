import { PgBoss } from 'pg-boss'
import { analyseProject, draftCampaign } from '@/server/agent'
import { recheckDns } from '@/server/health'
import { runImport } from '@/server/imports'
import { findLeads } from '@/server/leadsource'
import { agentTick } from '@/server/tick'
import { pollMailboxes, reapStuck, sendTick } from '@/server/mail'
import { QUEUES } from '@/server/queue'

async function main() {
  const boss = new PgBoss(process.env.DATABASE_URL!)
  boss.on('error', console.error)
  await boss.start()
  for (const queue of QUEUES) await boss.createQueue(queue)

  await boss.work<{ id: string }>('run-import', async ([job]) => runImport(job.data.id))
  await boss.work<{ id: string }>('analyse-project', async ([job]) => analyseProject(job.data.id))
  await boss.work<{ id: string }>('draft-campaign', async ([job]) => draftCampaign(job.data.id))
  await boss.work<{ id: string }>('find-leads', async ([job]) => findLeads(job.data.id))
  await boss.work('check-mailboxes', async () => void (await recheckDns()))
  await boss.work('agent-tick', async () => void (await agentTick()))
  await boss.work('send-tick', async () => void (await sendTick()))
  await boss.work('poll-mailbox', async () => void (await pollMailboxes()))
  await boss.work('reap-stuck', async () => void (await reapStuck()))

  if (process.env.WORKER_SCHEDULES === '0') {
    // Tests drive sending and polling by hand, so runs stay predictable.
    for (const queue of ['send-tick', 'poll-mailbox', 'reap-stuck', 'agent-tick']) await boss.unschedule(queue)
  } else {
    await boss.schedule('send-tick', '* * * * *')
    await boss.schedule('poll-mailbox', '* * * * *')
    await boss.schedule('reap-stuck', '*/5 * * * *')
    await boss.schedule('agent-tick', '* * * * *')
    await boss.schedule('check-mailboxes', '0 * * * *')
  }
  console.log('worker running')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
