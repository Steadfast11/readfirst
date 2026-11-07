import { pool } from '@/db'
import { pollMailboxes, reapStuck, sendTick } from '@/server/mail'
import { agentTick } from '@/server/tick'

/** One pass by hand, for local testing: npx tsx --env-file=.env.local src/worker/tick.ts */
async function main() {
  await agentTick()
  const sent = await sendTick()
  const received = await pollMailboxes()
  await agentTick()
  const reaped = await reapStuck()
  console.log(JSON.stringify({ sent, received, reaped }))
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
