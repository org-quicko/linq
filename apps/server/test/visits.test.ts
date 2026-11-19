import { describe, expect, test } from "bun:test"
import { URLSearchParamsToQueryParamsConverter } from "../src/converters/index.ts"
import { UrlUtil, UserAgentUtil } from "../src/utils/index.ts"

const uRLSearchParamsToQueryParamsConverter = new URLSearchParamsToQueryParamsConverter()

describe("detectPlatform", () => {
  test("maps the three families", () => {
    expect(UserAgentUtil.detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android")
    expect(UserAgentUtil.detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("ios")
    expect(UserAgentUtil.detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("ios")
    expect(UserAgentUtil.detectPlatform("Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0)")).toBe("ios")
    expect(UserAgentUtil.detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "desktop",
    )
  })

  test("an unknown or absent agent is a desktop", () => {
    expect(UserAgentUtil.detectPlatform(null)).toBe("desktop")
    expect(UserAgentUtil.detectPlatform("")).toBe("desktop")
    expect(UserAgentUtil.detectPlatform("curl/8.4.0")).toBe("desktop")
  })

  test("android wins when an agent claims both", () => {
    expect(UserAgentUtil.detectPlatform("Android; iPhone")).toBe("android")
  })
})

describe("classifyBot().is_bot", () => {
  test("flags crawlers", () => {
    expect(UserAgentUtil.classifyBot("Mozilla/5.0 (compatible; Googlebot/2.1)").is_bot).toBe(true)
    expect(UserAgentUtil.classifyBot("Twitterbot/1.0").is_bot).toBe(true)
  })

  test("leaves real browsers alone", () => {
    expect(
      UserAgentUtil.classifyBot(
        "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      ).is_bot,
    ).toBe(false)
  })

  test("a request with no user agent counts as a bot", () => {
    expect(UserAgentUtil.classifyBot(null).is_bot).toBe(true)
    expect(UserAgentUtil.classifyBot("").is_bot).toBe(true)
  })
})

describe("classifyBot", () => {
  test("records why each user agent was classified", () => {
    expect(UserAgentUtil.classifyBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toEqual({
      is_bot: true,
      bot_classification_reason: "isbot_match",
    })
    expect(UserAgentUtil.classifyBot(null)).toEqual({
      is_bot: true,
      bot_classification_reason: "missing_user_agent",
    })
    expect(UserAgentUtil.classifyBot("")).toEqual({
      is_bot: true,
      bot_classification_reason: "missing_user_agent",
    })
    expect(
      UserAgentUtil.classifyBot(
        "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      ),
    ).toEqual({
      is_bot: false,
      bot_classification_reason: "unknown",
    })
  })

  test("does not mistake representative browser user agents for bots", () => {
    const browsers = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15",
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
    ]
    for (const user_agent of browsers)
      expect(UserAgentUtil.classifyBot(user_agent)).toEqual({
        is_bot: false,
        bot_classification_reason: "unknown",
      })
  })
})

describe("mergeQuery", () => {
  const merge = (destination: string, query: string) =>
    UrlUtil.mergeQuery(destination, new URLSearchParams(query))

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

describe("convertURLSearchParamsToQueryParams", () => {
  test("groups repeats under one key", () => {
    expect(
      uRLSearchParamsToQueryParamsConverter.convertFrom(new URLSearchParams("a=1&a=2&b=3")),
    ).toEqual({
      a: ["1", "2"],
      b: ["3"],
    })
  })

  test("an empty query is stored as null, not an empty object", () => {
    expect(uRLSearchParamsToQueryParamsConverter.convertFrom(new URLSearchParams(""))).toBeNull()
  })

  test("a valueless parameter is kept as an empty string", () => {
    expect(uRLSearchParamsToQueryParamsConverter.convertFrom(new URLSearchParams("flag"))).toEqual({
      flag: [""],
    })
  })
})
