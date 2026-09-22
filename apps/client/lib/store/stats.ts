import type { StatsBucket } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

export type TagCount = { tag: string; count: number }

export const statsApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    getStats: build.query<
      StatsBucket[],
      { path: string; params?: Record<string, string | undefined> }
    >({
      query: ({ path, params }) => ({ path: `${path}${qs(params ?? {})}` }),
      providesTags: ["Stats"],
    }),

    /** Derived from active links' own `tags` arrays, so it goes stale on the
     *  same writes `listLinks`'s rows do — shares its "LIST" tag rather than
     *  invalidating on its own, same as `countLinks`. Without this, a tag
     *  added after the picker's first fetch would never show up in it. */
    listTags: build.query<TagCount[], void>({
      query: () => ({ path: "/v1/tags" }),
      providesTags: [{ type: "Link", id: "LIST" }],
    }),
  }),
})

export const { useGetStatsQuery, useListTagsQuery } = statsApi
