import { parseArgs } from "node:util"
import { ROLES, type Role } from "@linq/shared"
import { createApiKey } from "../auth/mint.ts"
import { loadConfig } from "../config.ts"
import { createDb } from "../db/client.ts"

/**
 * Mints a key from the shell: `bun run key:create --name ops --role admin`.
 *
 * This is the only way a key exists without one already existing, so it is also
 * the way back in when every key has been lost or revoked. It does not run
 * migrations — against a database the server has never started, the missing
 * table is the error you want to see.
 */
const { values } = parseArgs({
  options: {
    name: { type: "string" },
    role: { type: "string", default: "admin" },
    expires: { type: "string" },
  },
})

const name = values.name?.trim()
if (!name) {
  console.error("usage: bun run key:create --name <name> [--role <role>] [--expires <ISO date>]")
  process.exit(1)
}

const role = values.role as Role
if (!ROLES.includes(role)) {
  console.error(`--role must be one of: ${ROLES.join(", ")}`)
  process.exit(1)
}

let expires_at: Date | null = null
if (values.expires) {
  expires_at = new Date(values.expires)
  if (Number.isNaN(expires_at.getTime())) {
    console.error(`--expires is not a date: ${values.expires}`)
    process.exit(1)
  }
}

const db = createDb(loadConfig().DATABASE_URL)
const { secret } = await createApiKey(db, { name, role, expires_at })

// Printed, never logged: a plaintext key in a rotating file on a mounted volume
// is strictly worse than one line in the operator's terminal.
console.log(`\n  linq ${role} API key: ${secret}\n  Store it now; it is not recoverable.\n`)
process.exit(0)
