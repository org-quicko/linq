import { claimsForPreset } from "@linq/shared"
/** Local-only fixture: uses the dedicated linq_scale database on port 55441.
 * Run from the repository root. Bulk loading bypasses only the insert rollup
 * trigger and rebuilds its aggregates afterward; this is not an ingestion load test.
 */
import { sql } from "kysely"
import { DbClient } from "../../src/clients/index.ts"
import { runMigrations } from "../../src/db/migrate.ts"
import { ApiKeyService } from "../../src/services/index.ts"

const db = DbClient.start({
  DATABASE_URL: "postgres://linq@127.0.0.1:55441/linq_scale",
  LINQ_DB_SCHEMA: "public",
})
await runMigrations(db)
const domainId = "11111111-1111-4111-8111-111111111111"
await db
  .insertInto("domains")
  .values({ id: domainId, host: "localhost:3000" })
  .onConflict((o) => o.column("id").doNothing())
  .execute()
for (let n = 0; n < 100; n++) {
  await db
    .insertInto("links")
    .values({
      id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
      domain_id: domainId,
      slug: `scale-${n}`,
      name: `Scale link ${n}`,
      destination: "https://example.com/scale",
      listed: true,
      preset_params: "{}",
    })
    .onConflict((o) => o.column("id").doNothing())
    .execute()
}
const keyService = new ApiKeyService(db)
const savedKey = Bun.file("data/scale-check/key.txt")
const keyIsValid =
  (await savedKey.exists()) && (await keyService.findByToken((await savedKey.text()).trim()))
if (!keyIsValid) {
  const { secret } = await keyService.create({
    name: "Scale verification",
    claims: claimsForPreset.admin,
  })
  await Bun.write("data/scale-check/key.txt", secret)
}
const before = await sql<{ count: number }>`select count(*)::int as count from visits`.execute(db)
if (before.rows[0].count > 4_000_000)
  throw new Error("Use a fresh fixture database before reseeding after live verification")
await sql`alter table visits disable trigger visits_rollup`.execute(db)
const start = performance.now()
try {
  for (let offset = before.rows[0].count; offset < 4_000_000; offset += 100_000) {
    await sql`insert into visits (id,domain_id,link_id,slug_requested,visited_at,is_bot,platform,os,browser,user_agent,referer,destination,query_params,country,region)
 select md5('scale-visit-'||g)::uuid, ${domainId}::uuid,
 case when g%20=0 then null else ('22222222-2222-4222-8222-'||lpad((g%100)::text,12,'0'))::uuid end,
 'scale-'||(g%100), date_trunc('day',now())-((g%90)::text||' days')::interval+((g%86400)::text||' seconds')::interval,
 g%5=0, (case g%3 when 0 then 'desktop' when 1 then 'android' else 'ios' end)::platform,
 case g%3 when 0 then 'windows' when 1 then 'android' else 'ios' end,
 case g%2 when 0 then 'chrome' else 'safari' end,
 case g%3 when 0 then 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' when 1 then 'Mozilla/5.0 (Linux; Android 14; Mobile)' else 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' end,
 'https://example.org/news','https://example.com/scale',
 jsonb_build_object('utm_source',jsonb_build_array(case g%2 when 0 then 'newsletter' else 'social' end),'utm_medium',jsonb_build_array('scale-test')),
 case g%2 when 0 then 'IN' else 'US' end, null
 from generate_series(${offset + 1}::int,${Math.min(offset + 100_000, 4_000_000)}::int) g`.execute(
      db,
    )
    console.log(
      JSON.stringify({
        visits: Math.min(offset + 100_000, 4_000_000),
        seconds: Math.round((performance.now() - start) / 1000),
      }),
    )
  }
} finally {
  await sql`alter table visits enable trigger visits_rollup`.execute(db)
}
console.log("Rebuilding rollups")
await sql`truncate visit_counts, visit_days`.execute(db)
await sql`insert into visit_counts (domain_id,link_id,human,bot,last_visit_at)
select domain_id,link_id,count(*) filter(where not is_bot),count(*) filter(where is_bot),max(visited_at)
from visits group by domain_id,link_id`.execute(db)
for (const [dimension, expression] of Object.entries({
  total: "''",
  platform: "platform::text",
  os: "os",
  browser: "browser",
  referer: "referer_host",
  destination: "destination",
  slug: "slug_requested",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  utm_content: "utm_content",
  utm_term: "utm_term",
  device_type: "device_type",
})) {
  await sql
    .raw(`insert into visit_days (day,domain_id,link_id,dimension,value,is_bot,count)
 select (visited_at at time zone 'UTC')::date,domain_id,link_id,'${dimension}'::visit_dimension,coalesce(${expression},''),is_bot,count(*)
 from visits group by 1,2,3,4,5,6`)
    .execute(db)
  console.log(`Rollup ${dimension} complete`)
}
await sql`analyze visits`.execute(db)
await sql`analyze visit_days`.execute(db)
await sql`analyze visit_counts`.execute(db)
console.log(
  "SEED COMPLETE",
  JSON.stringify(
    (
      await sql`select count(*)::int as visits, count(*) filter(where is_bot)::int as bots from visits`.execute(
        db,
      )
    ).rows,
  ),
)
await db.destroy()
