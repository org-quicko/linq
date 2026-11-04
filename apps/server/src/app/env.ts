import type { Principal } from "../auth/middleware.ts"
import type { Deps } from "../deps.ts"

/** Everything a route handler reads off the context. */
export type Env = {
  Variables: Deps & {
    /** Set by the auth middleware; only present under /api/v1. */
    principal: Principal
  }
}
