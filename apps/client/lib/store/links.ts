import type { Link, LinkCreate, LinkPatch, Page, Rule } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

type LinkFilters = {
  domain_id?: string
  status?: "active" | "archived" | "all"
  sort?: "created_at" | "updated_at" | "visits"
  order?: "asc" | "desc"
  search?: string
  tags?: string
  limit?: number
  offset?: number
}

/** `linksFeed`'s query arg: the same filters minus the pagination fields,
 *  which the endpoint itself owns (fixed page size, `pageParam` as the
 *  offset). */
type LinkInfiniteFilters = Pick<LinkFilters, "domain_id" | "tags" | "search" | "order">

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

    /** The links list's infinite-scroll feed (plans/Plan_31.md §B4). Kept
     *  separate from `listLinks` rather than replacing it: `analytics-overview.tsx`
     *  and `archives/page.tsx` both page-fetch a fixed set and neither wants
     *  the accumulating-pages shape this returns. */
    linksFeed: build.infiniteQuery<Page<Link>, LinkInfiniteFilters, number>({
      infiniteQueryOptions: {
        initialPageParam: 0,
        // Stops on an empty page as well as on `total`, not just `total`
        // alone: a filter change or a concurrent delete can make `total`
        // stale, and an empty page is the one signal that can never lie.
        getNextPageParam: (last, _allPages, lastParam) => {
          if (last.data.length === 0) return undefined
          const next = lastParam + last.limit
          return next < last.total ? next : undefined
        },
      },
      query: ({ queryArg, pageParam }) => ({
        path: `/v1/links${qs({ ...queryArg, sort: "created_at", limit: 25, offset: pageParam })}`,
      }),
      providesTags: (result) =>
        result
          ? [
              ...result.pages.flatMap((page) =>
                page.data.map((link) => ({ type: "Link" as const, id: link.id })),
              ),
              { type: "Link" as const, id: "LIST" },
            ]
          : [{ type: "Link" as const, id: "LIST" }],
    }),

    getLink: build.query<Link, string>({
      query: (id) => ({ path: `/v1/links/${id}` }),
      providesTags: (_result, _error, id) => [{ type: "Link", id }],
    }),

    getLinkRules: build.query<Rule[], string>({
      query: (link_id) => ({ path: `/v1/links/${link_id}/rules` }),
      providesTags: (_result, _error, link_id) => [{ type: "Link", id: `${link_id}-rules` }],
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

    /** Also invalidates the QR list: the server's `ON DELETE CASCADE` destroys
     *  a purged link's QR codes, and without this the QR list keeps rendering
     *  a row whose link no longer exists. `archiveLink` needs no equivalent —
     *  the link (and its QR codes) are still real, just badged archived. */
    purgeLink: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/links/${id}/purge`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Link", id },
        { type: "Link", id: "LIST" },
        { type: "QrCode", id: "LIST" },
      ],
    }),

    updateLinkRules: build.mutation<void, { link_id: string; rules: unknown[] }>({
      query: ({ link_id, rules }) => ({
        path: `/v1/links/${link_id}/rules`,
        method: "PUT",
        body: rules,
      }),
      invalidatesTags: (_result, _error, { link_id }) => [{ type: "Link", id: `${link_id}-rules` }],
    }),
  }),
})

export const {
  useListLinksQuery,
  useLinksFeedInfiniteQuery,
  useGetLinkQuery,
  useGetLinkRulesQuery,
  useCreateLinkMutation,
  useUpdateLinkMutation,
  useArchiveLinkMutation,
  usePurgeLinkMutation,
  useUpdateLinkRulesMutation,
} = linksApi
