import type { Click, Link, Page, Rule } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

type LinkFilters = {
  domainId?: string
  status?: "active" | "archived" | "all"
  sort?: "createdAt" | "clicks"
  search?: string
  tags?: string
  limit?: number
  offset?: number
}

export const linksApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    listLinks: build.query<Page<Link>, LinkFilters>({
      query: (filters) => ({ path: `/v1/links${qs(filters)}` }),
      providesTags: (result) =>
        result
          ? [
              ...result.data.map((link) => ({ type: "Link" as const, id: link.id })),
              { type: "Link" as const, id: "LIST" },
            ]
          : [{ type: "Link" as const, id: "LIST" }],
    }),

    getLink: build.query<Link, string>({
      query: (id) => ({ path: `/v1/links/${id}` }),
      providesTags: (_result, _error, id) => [{ type: "Link", id }],
    }),

    getLinkRules: build.query<Rule[], string>({
      query: (linkId) => ({ path: `/v1/links/${linkId}/rules` }),
      providesTags: (_result, _error, linkId) => [{ type: "Link", id: `${linkId}-rules` }],
    }),

    getLinkClicks: build.query<Page<Click>, { linkId: string; bot: "any" | "true" | "false" }>({
      query: ({ linkId, bot }) => ({ path: `/v1/links/${linkId}/clicks${qs({ bot, limit: 25 })}` }),
      providesTags: (_result, _error, { linkId }) => [{ type: "Link", id: `${linkId}-clicks` }],
    }),

    createLink: build.mutation<Link, Record<string, unknown>>({
      query: (body) => ({ path: "/v1/links", method: "POST", body }),
      invalidatesTags: [{ type: "Link", id: "LIST" }],
    }),

    updateLink: build.mutation<Link, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ path: `/v1/links/${id}`, method: "PATCH", body }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Link", id },
        { type: "Link", id: "LIST" },
      ],
    }),

    archiveLink: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/links/${id}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Link", id },
        { type: "Link", id: "LIST" },
      ],
    }),

    purgeLink: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/links/${id}/purge`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Link", id },
        { type: "Link", id: "LIST" },
      ],
    }),

    updateLinkRules: build.mutation<void, { linkId: string; rules: unknown[] }>({
      query: ({ linkId, rules }) => ({
        path: `/v1/links/${linkId}/rules`,
        method: "PUT",
        body: rules,
      }),
      invalidatesTags: (_result, _error, { linkId }) => [{ type: "Link", id: `${linkId}-rules` }],
    }),
  }),
})

export const {
  useListLinksQuery,
  useGetLinkQuery,
  useGetLinkRulesQuery,
  useGetLinkClicksQuery,
  useCreateLinkMutation,
  useUpdateLinkMutation,
  useArchiveLinkMutation,
  usePurgeLinkMutation,
  useUpdateLinkRulesMutation,
} = linksApi
