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

    listTags: build.query<TagCount[], void>({
      query: () => ({ path: "/v1/tags" }),
    }),
  }),
})

export const { useGetStatsQuery, useListTagsQuery } = statsApi
