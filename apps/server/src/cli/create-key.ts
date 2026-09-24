import { claimsForPreset, PRESETS, type KeyPreset } from "@linq/shared"
import { parseArgs } from "node:util"
import { createApiKey } from "../auth/mint.ts"
import { loadConfig } from "../config.ts"
import { createDb } from "../db/client.ts"

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    preset: { type: "string", default: "admin" },
    expires: { type: "string" },
  },
})
const name = values.name?.trim()
if (!name) {
  console.error(
    "usage: bun run key:create --name <name> [--preset <preset>] [--expires <ISO date>]",
  )
  process.exit(1)
}
const preset = values.preset as KeyPreset
if (!PRESETS.includes(preset)) {
  console.error(`--preset must be one of: ${PRESETS.join(", ")}`)
  process.exit(1)
}
const expires_at = values.expires ? new Date(values.expires) : null
if (expires_at && Number.isNaN(expires_at.getTime())) {
  console.error(`--expires is not a date: ${values.expires}`)
  process.exit(1)
}
const { secret } = await createApiKey(createDb(loadConfig().DATABASE_URL), {
  name,
  claims: claimsForPreset[preset],
  expires_at,
})
console.log(`\n  linq ${preset} API key: ${secret}\n  Store it now; it is not recoverable.\n`)
