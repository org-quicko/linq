import { claimsForPreset, type ErrorBody, type Link, type StatsBucket } from "@linq/shared"
import { sql } from "kysely"

import { ApiKeyService } from "../../src/services/index.ts"

const key = (await Bun.file("data/scale-check/key.txt").text()).trim()
process.env.DATABASE_URL = "postgres://linq@127.0.0.1:55441/linq_scale"
process.env.LINQ_DB_SCHEMA = "public"
const { db } = await import("../../src/db/index.ts")
const results: { path: string; status: number; ms: number; body: unknown }[] = []
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function request<T = Record<string, number>>(
  path: string,
  options: RequestInit = {},
  token = key,
) {
  const start = performance.now()
  const response = await fetch(`http://localhost:3000/api${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...options.headers,
    },
  })
  const body = (response.status === 204 ? null : await response.json()) as T
  results.push({ path, status: response.status, ms: Math.round(performance.now() - start), body })
  return { response, body }
}
const raw = (
  await sql`select count(*)::int visits,count(*) filter(where not is_bot)::int human,count(*) filter(where is_bot)::int bot,count(*) filter(where link_id is null)::int orphans from visits`.execute(
    db,
  )
).rows[0] as Record<string, number>
check(raw.visits === 4_000_000, "Fixture count")
const counts = (
  await sql`select sum(human)::int human,sum(bot)::int bot from visit_counts`.execute(db)
).rows[0] as Record<string, number>
check(counts.human === raw.human && counts.bot === raw.bot, "visit_counts mismatch")
const rollups = (
  await sql`select dimension,sum(count)::int total from visit_days group by dimension`.execute(db)
).rows as { dimension: string; total: number }[]
check(
  rollups.length === 13 && rollups.every((r) => r.total === raw.visits),
  "Daily rollup mismatch",
)
const summary = await request("/v1/analytics/summary")
check(
  summary.response.ok && Object.entries(raw).every(([k, v]) => summary.body[k] === v),
  "Summary mismatch",
)
const series = await request<StatsBucket[]>("/v1/analytics/timeseries")
check(
  series.response.ok &&
    series.body.reduce((n: number, r: { human: number; bot: number }) => n + r.human + r.bot, 0) ===
      raw.visits,
  "Timeseries mismatch",
)
const breakdown = await request<StatsBucket[]>("/v1/analytics/breakdown?dimension=platform")
check(
  breakdown.response.ok &&
    breakdown.body.reduce(
      (n: number, r: { human: number; bot: number }) => n + r.human + r.bot,
      0,
    ) === raw.visits,
  "Breakdown mismatch",
)
const from = new Date(Date.now() - 91 * 86400000).toISOString().slice(0, 10)
const filtered = await request(`/v1/analytics/summary?from=${from}&browser=chrome`)
check(filtered.response.ok && filtered.body.visits === 2_000_000, "Filtered detail mismatch")
for (const offset of [0, 100000, 3999990]) {
  const page = await request<{ total: number; data: unknown[] }>(
    `/v1/visits?limit=10&offset=${offset}`,
  )
  check(
    page.response.ok && page.body.total === 4_000_000 && page.body.data.length === 10,
    "Visit pagination mismatch",
  )
}
const links = await request("/v1/links?limit=10&sort=visits")
check(links.response.ok && links.body.total === 100, "Link list")
for (const [path, options, status, code] of [
  ["/v1/domains", { method: "POST", body: "{}" }, 400, "validation_failed"],
  [
    "/v1/domains",
    { method: "POST", body: JSON.stringify({ host: "localhost:3000" }) },
    409,
    "conflict",
  ],
  ["/v1/links/99999999-9999-4999-8999-999999999999", {}, 404, "not_found"],
] as const) {
  const r = await request<ErrorBody>(path, options)
  check(r.response.status === status && r.body.error.code === code, `Error contract ${status}`)
}
const unauthorized = await request("/v1/links", {}, "invalid")
check(unauthorized.response.status === 401, "Unauthorized")
const { secret: viewer } = await new ApiKeyService(db).create({
  name: "Scale viewer",
  claims: claimsForPreset.viewer,
})
const forbidden = await request(
  "/v1/domains",
  { method: "POST", body: JSON.stringify({ host: "forbidden.test" }) },
  viewer,
)
check(forbidden.response.status === 403, "Forbidden")
const created = await request<Link>("/v1/links", {
  method: "POST",
  body: JSON.stringify({
    domain_id: "11111111-1111-4111-8111-111111111111",
    slug: "scale-created",
    destination: "https://example.com/new",
  }),
})
check(created.response.status === 201, "Link create")
const updated = await request<Link>(`/v1/links/${created.body.id}`, {
  method: "PATCH",
  body: JSON.stringify({ destination: "https://example.com/updated" }),
})
check(
  updated.response.ok && updated.body.destination === "https://example.com/updated",
  "Link update",
)
const archived = await request(`/v1/links/${created.body.id}`, { method: "DELETE" })
check(archived.response.ok, "Link archive")
const redirect = await fetch("http://localhost:3000/scale-1", {
  redirect: "manual",
  headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0" },
})
check(
  redirect.status === 302 && redirect.headers.get("location") === "https://example.com/scale",
  "Redirect",
)
await Bun.write(
  "data/scale-check/api-results.json",
  JSON.stringify({ raw, counts, rollups, results, redirect: redirect.status }, null, 2),
)
console.log(
  JSON.stringify(
    {
      raw,
      checks: results.map((r) => ({ path: r.path, status: r.status, ms: r.ms })),
      redirect: redirect.status,
    },
    null,
    2,
  ),
)
await db.destroy()
