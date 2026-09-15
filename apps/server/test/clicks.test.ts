import { describe, expect, test } from "bun:test"
import { detectBot } from "../src/clicks/bot.ts"
import { detectPlatform } from "../src/clicks/platform.ts"
import { mergeQuery, queryMap } from "../src/http/redirect.ts"

describe("detectPlatform", () => {
  test("maps the three families", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android")
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("ios")
    expect(detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("ios")
    expect(detectPlatform("Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0)")).toBe("ios")
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("desktop")
  })

  test("an unknown or absent agent is a desktop", () => {
    expect(detectPlatform(null)).toBe("desktop")
    expect(detectPlatform("")).toBe("desktop")
    expect(detectPlatform("curl/8.4.0")).toBe("desktop")
  })

  test("android wins when an agent claims both", () => {
    expect(detectPlatform("Android; iPhone")).toBe("android")
  })
})

describe("detectBot", () => {
  test("flags crawlers", () => {
    expect(detectBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true)
    expect(detectBot("Twitterbot/1.0")).toBe(true)
  })

  test("leaves real browsers alone", () => {
    expect(detectBot("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36")).toBe(
      false,
    )
  })

  test("a request with no user agent counts as a bot", () => {
    expect(detectBot(null)).toBe(true)
    expect(detectBot("")).toBe(true)
  })
})

describe("mergeQuery", () => {
  const merge = (destination: string, query: string) =>
    mergeQuery(destination, new URLSearchParams(query))

  test("keeps destination parameters the caller did not send", () => {
    expect(merge("https://e.test/?a=1&b=2", "c=3")).toBe("https://e.test/?a=1&b=2&c=3")
  })

  test("incoming parameters win", () => {
    expect(merge("https://e.test/?a=1", "a=2")).toBe("https://e.test/?a=2")
  })

  test("a repeated incoming key replaces every destination copy", () => {
    expect(merge("https://e.test/?t=old&t=older", "t=new&t=newer")).toBe(
      "https://e.test/?t=new&t=newer",
    )
  })

  test("an empty query leaves the URL untouched, fragment included", () => {
    expect(merge("https://e.test/path?x=1#frag", "")).toBe("https://e.test/path?x=1#frag")
  })

  test("values are re-encoded, not pasted through", () => {
    expect(merge("https://e.test/", "q=a b&r=%2F")).toBe("https://e.test/?q=a+b&r=%2F")
  })
})

describe("queryMap", () => {
  test("groups repeats under one key", () => {
    expect(queryMap(new URLSearchParams("a=1&a=2&b=3"))).toEqual({ a: ["1", "2"], b: ["3"] })
  })

  test("an empty query is stored as null, not an empty object", () => {
    expect(queryMap(new URLSearchParams(""))).toBeNull()
  })

  test("a valueless parameter is kept as an empty string", () => {
    expect(queryMap(new URLSearchParams("flag"))).toEqual({ flag: [""] })
  })
})
