import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type CountryResponse, Reader, validate } from "maxmind"
import type { Config } from "../config.ts"
import { log, reqLog, span } from "../log.ts"

const EDITION = "dbip-country-lite"
// DB-IP publishes monthly, so a week keeps staleness bounded at ~5 weeks; a
// month-long window can miss a whole publication cycle.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const RECHECK_EVERY_MS = 24 * 60 * 60 * 1000

export type Location = { country: string | null; region: string | null }
const NOWHERE: Location = { country: null, region: null }

export type Geo = {
  /** Empty when the database is unavailable or the address is not in it. */
  lookup(ip: string | null): Location
  stop(): void
}

/** What runs when geo is switched off. */
export const noGeo: Geo = { lookup: () => NOWHERE, stop: () => {} }

/**
 * Opens the DB-IP Country Lite database and re-checks daily. Unless the operator
 * supplied one with `LINQ_GEO_DB_PATH`, it is downloaded first when missing or
 * stale. Every failure is logged and swallowed: location is a nice-to-have and
 * must never keep the server from serving, so a supplied path that is missing
 * degrades rather than exits.
 *
 * The download needs no account and no key, so this runs for every operator by
 * default. See docs/adr/0004 and docs/adr/0005.
 */
export async function startGeo(config: Config): Promise<Geo> {
  if (!config.LINQ_GEO_ENABLED) {
    log.info({ enabled: false }, "geo: disabled, clicks will have no location")
    return noGeo
  }

  // A supplied database is the operator's to manage, freshness included.
  const supplied = config.LINQ_GEO_DB_PATH
  const path = supplied ?? join(config.LINQ_GEO_DIR, `${EDITION}.mmdb`)
  let reader: Reader<CountryResponse> | null = null

  /** Downloads when stale, then reopens the reader. Runs at boot and daily after. */
  const refresh = async () => {
    try {
      if (!supplied && (await isStale(path))) await downloadMmdb(config.LINQ_GEO_DIR, path)
      reader = new Reader<CountryResponse>(await readFile(path))
    } catch (err) {
      log.error({ err }, `geo: ${EDITION} unavailable, clicks will have no location`)
    }
  }

  await span("geo.start", refresh, { in: { path } })
  // The span logs its `in` at debug, so without this an operator running at the
  // default level cannot tell which of the two modes won.
  log.info(
    { source: supplied ? "supplied" : "download", path, ready: reader !== null },
    "geo: ready",
  )

  // The timer runs in both modes: for a supplied path it reopens the reader, so
  // an operator who drops in a newer file gets it within a day, without a restart.
  const timer = setInterval(refresh, RECHECK_EVERY_MS)
  timer.unref?.()

  return {
    lookup(ip) {
      // Two inline lines rather than a span: this is synchronous and sub-
      // microsecond, and wrapping it would put a microtask on the redirect path.
      // The address itself is never logged. See docs/adr/0003.
      if (!ip || !reader || !validate(ip)) {
        reqLog().debug({ resolved: false }, "geo lookup")
        return NOWHERE
      }
      // The Country edition carries no subdivisions, so `region` stays null until
      // the city file is adopted. See docs/adr/0004.
      const location = { country: reader.get(ip)?.country?.iso_code ?? null, region: null }
      reqLog().debug({ resolved: true, ...location }, "geo lookup")
      return location
    },
    stop: () => clearInterval(timer),
  }
}

/** A missing file counts as stale, which is what triggers the first download. */
async function isStale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_AFTER_MS
  } catch {
    return true
  }
}

/** `YYYY-MM` in UTC, `back` whole months ago. */
function monthStamp(back: number): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** Fetches the DB-IP database and writes the unpacked .mmdb to disk. */
function downloadMmdb(dir: string, path: string): Promise<void> {
  return span("geo.download", () => fetchMmdb(dir, path), { in: { path } })
}

async function fetchMmdb(dir: string, path: string): Promise<void> {
  // There is no `latest` alias: next month's file only appears partway through
  // the 1st, so the previous month is the fallback rather than a failure.
  let last = ""
  for (const back of [0, 1]) {
    const url = `https://download.db-ip.com/free/${EDITION}-${monthStamp(back)}.mmdb.gz`
    const res = await fetch(url)
    if (!res.ok) {
      last = `${res.status} ${res.statusText}`
      continue
    }
    const mmdb = Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))
    await mkdir(dir, { recursive: true })
    await writeFile(path, mmdb)
    return
  }
  throw new Error(`download failed with ${last}`)
}
