import type { z } from "zod"
import type { domainCreateSchema, domainPatchSchema } from "../schemas/index.ts"

/** A domain as the API returns it. */
export type Domain = {
  id: string
  host: string
  fallback_url: string | null
  base_path_redirect: string | null
  invalid_short_url_redirect: string | null
  status: "active" | "archived"
  link_count: number
  created_at: string
  updated_at: string
}

/** A validated `POST /domains` body. */
export type DomainCreateInput = z.infer<typeof domainCreateSchema>

/** A validated `PATCH /domains/:id` body. */
export type DomainPatch = z.infer<typeof domainPatchSchema>

/** A `domains` row as the database returns it. */
export type DomainRow = {
  id: string
  host: string
  fallback_url: string | null
  base_path_redirect: string | null
  invalid_short_url_redirect: string | null
  status: "active" | "archived"
  created_at: Date
  updated_at: Date
}

/** A `domains` row joined to its link count, archived links included. */
export type DomainJoinedRow = DomainRow & { link_count: number }

/** The `domains` columns a create sets; the caller adds `id`. */
export type DomainInsert = Pick<
  DomainRow,
  "host" | "fallback_url" | "base_path_redirect" | "invalid_short_url_redirect"
>
