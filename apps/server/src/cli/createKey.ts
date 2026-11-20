import { parseArgs } from "node:util"
import { claimsForPreset, type KeyPreset, PRESETS } from "@linq/shared"

import { ApiKeyService } from "../services/index.ts"

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
const expiresAt = values.expires ? new Date(values.expires) : null
if (expiresAt && Number.isNaN(expiresAt.getTime())) {
  console.error(`--expires is not a date: ${values.expires}`)
  process.exit(1)
}

const { db } = await import("../db/index.ts")
try {
  const { secret } = await new ApiKeyService(db).create({
    name,
    claims: claimsForPreset[preset],
    expiresAt,
  })
  console.log(`\n  linq ${preset} API key: ${secret}\n  Store it now; it is not recoverable.\n`)
} finally {
  await db.destroy()
}
