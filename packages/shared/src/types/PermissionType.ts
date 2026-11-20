import type { MongoAbility } from "@casl/ability"
import type { z } from "zod"
import type { ACTIONS, PRESETS, SUBJECTS } from "../constants/index.ts"
import type { claimSchema } from "../schemas/index.ts"

export type Action = (typeof ACTIONS)[number]

export type Subject = (typeof SUBJECTS)[number]

export type Claim = z.infer<typeof claimSchema>

export type AppAbility = MongoAbility<[Action, Subject]>

export type KeyPreset = (typeof PRESETS)[number]

/** Who is acting. The server authenticates this key; the UI only mirrors it. */
export type Actor = { keyId: string; claims: Claim[] }

/** A key is the principal; its CASL ability is built once after authentication. */
export type Principal = { keyId: string; claims: Claim[]; ability: AppAbility; name: string }
