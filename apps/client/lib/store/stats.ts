import type { AnalyticsSummary, StatsBucket } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

export type TagCount = { tag: string; count: number }

export const statsApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    getAnalyticsSummary: build.query<AnalyticsSummary, Record<string, string | undefined>>({
      query: (params) => ({ path: `/v1/analytics/summary${qs(params)}` }),
      providesTags: ["Stats"],
    }),
    getAnalyticsTimeseries: build.query<StatsBucket[], Record<string, string | undefined>>({
      query: (params) => ({ path: `/v1/analytics/timeseries${qs(params)}` }),
      providesTags: ["Stats"],
    }),
    getAnalyticsBreakdown: build.query<
      StatsBucket[],
      Record<string, string | undefined> & { dimension: string }
    >({
      query: ({ dimension, ...params }) => ({
        path: `/v1/analytics/breakdown${qs({ dimension, ...params })}`,
      }),
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

export const {
  useGetAnalyticsBreakdownQuery,
  useGetAnalyticsSummaryQuery,
  useGetAnalyticsTimeseriesQuery,
  useListTagsQuery,
} = statsApi
