import { notFound } from 'next/navigation'
import { ApiError } from './http'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: string) => UUID.test(value)

/** Pages show a 404 for anything missing or belonging to someone else. */
export async function orNotFound<T>(work: Promise<T>) {
  try {
    return await work
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }
}

export async function orNull<T>(work: Promise<T>) {
  try {
    return await work
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}
