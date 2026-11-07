import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

const globals = globalThis as unknown as { pool?: Pool }

export const pool = (globals.pool ??= new Pool({ connectionString: process.env.DATABASE_URL }))
export const db = drizzle(pool, { schema })
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type Db = typeof db | Tx
export * as t from './schema'
