import type { Claim } from "@linq/shared"
import type { Db } from "../db/client.ts"
import { generateKey, hashKey, keyPrefix } from "./keys.ts"

export async function createApiKey(
  db: Db,
  opts: { name: string; claims: readonly Claim[]; expires_at?: Date | null },
) {
  const secret = generateKey()
  const row = await db
    .insertInto("api_keys")
    .values({
      id: Bun.randomUUIDv7(),
      name: opts.name,
      claims: JSON.stringify(opts.claims),
      key_hash: hashKey(secret),
      prefix: keyPrefix(secret),
      expires_at: opts.expires_at ?? null,
    })
    .returningAll()
    .executeTakeFirst()
  if (!row) throw new Error("insert returned no row")
  return { row, secret }
}
