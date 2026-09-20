import type { Link, LinkCreate, LinkPatch, Page, Rule } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

type LinkFilters = {
  domainId?: string
  status?: "active" | "archived" | "all"
  sort?: "createdAt" | "updatedAt" | "visits"
  order?: "asc" | "desc"
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

    createLink: build.mutation<Link, LinkCreate>({
      query: (body) => ({ path: "/v1/links", method: "POST", body }),
      invalidatesTags: [{ type: "Link", id: "LIST" }],
    }),

    updateLink: build.mutation<Link, { id: string; body: LinkPatch }>({
      query: ({ id, body }) => ({ path: `/v1/links/${id}`, method: "PATCH", body }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Link", id },
        { type: "Link", id: `${id}-rules` },
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
  useCreateLinkMutation,
  useUpdateLinkMutation,
  useArchiveLinkMutation,
  usePurgeLinkMutation,
  useUpdateLinkRulesMutation,
} = linksApi
