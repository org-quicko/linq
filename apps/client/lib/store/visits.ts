import type { Browser, Os, Page, Platform, Visit } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

export type VisitFilters = {
  linkId?: string
  domainId?: string
  orphan?: "true"
  bot?: "any" | "true" | "false"
  platform?: Platform
  os?: Os
  browser?: Browser
  botLabel?: string
  from?: string
  limit?: number
  offset?: number
}

export const visitsApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    /**
     * One endpoint for every scope: the link detail card passes `linkId`, the
     * visits page passes whatever its filters are set to, and `qs` drops the
     * ones left undefined.
     */
    listVisits: build.query<Page<Visit>, VisitFilters>({
      query: (filters) => ({ path: `/v1/visits${qs(filters)}` }),
      providesTags: ["Visit"],
    }),
  }),
})

export const { useListVisitsQuery } = visitsApi
