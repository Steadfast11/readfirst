import { draftQueued, queueFollowUps } from './agent'
import { protectSending } from './health'
import { verifyPending } from './leadsource'
import { processReplies } from './replies'

/** One pass of the AI work: replies first, because they can stop other mail. */
export async function agentTick() {
  const classified = await processReplies()
  await protectSending()
  const followUps = await queueFollowUps()
  const drafted = await draftQueued()
  await verifyPending()
  return { classified, followUps, drafted }
}
