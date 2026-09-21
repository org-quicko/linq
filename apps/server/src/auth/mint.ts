import type { Role } from "@linq/shared"
import type { Db } from "../db/client.ts"
import { apiKeys } from "../db/schema.ts"
import { generateKey, hashKey, keyPrefix } from "./keys.ts"

/**
 * Creates a key and returns the plaintext secret alongside the row.
 *
 * The secret is returned exactly once and is not recoverable: only its sha256
 * is stored. Shared by the HTTP route and `bun run key:create`, so the two
 * cannot mint keys that differ in shape.
 */
export async function createApiKey(
  db: Db,
  opts: { name: string; role: Role; expires_at?: Date | null },
): Promise<{ row: typeof apiKeys.$inferSelect; secret: string }> {
  const secret = generateKey()
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: Bun.randomUUIDv7(),
      name: opts.name,
      role: opts.role,
      key_hash: hashKey(secret),
      prefix: keyPrefix(secret),
      expires_at: opts.expires_at ?? null,
    })
    .returning()
  if (!row) throw new Error("insert returned no row")
  return { row, secret }
}
