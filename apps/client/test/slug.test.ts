import { expect, test } from "bun:test"
import { SLUG_LENGTH, randomSlug } from "../lib/slug.ts"

test("randomSlug is base62 of the requested length and varies", () => {
  expect(randomSlug()).toMatch(new RegExp(`^[0-9A-Za-z]{${SLUG_LENGTH}}$`))
  expect(randomSlug(12)).toHaveLength(12)
  expect(new Set(Array.from({ length: 50 }, () => randomSlug())).size).toBeGreaterThan(45)
})
