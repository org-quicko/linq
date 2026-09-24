import type { Domain, Page } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

export const domainsApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    listDomains: build.query<Page<Domain>, { limit?: number }>({
      query: (params) => ({ path: `/v1/domains${qs(params)}` }),
      providesTags: (result) =>
        result
          ? [
              ...result.data.map((domain) => ({ type: "Domain" as const, id: domain.id })),
              { type: "Domain" as const, id: "LIST" },
            ]
          : [{ type: "Domain" as const, id: "LIST" }],
    }),

    createDomain: build.mutation<
      Domain,
      {
        host: string
        fallback_url?: string | null
        base_path_redirect?: string | null
        invalid_short_url_redirect?: string | null
      }
    >({
      query: (body) => ({ path: "/v1/domains", method: "POST", body }),
      invalidatesTags: [{ type: "Domain", id: "LIST" }],
    }),

    updateDomain: build.mutation<Domain, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ path: `/v1/domains/${id}`, method: "PATCH", body }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Domain", id },
        { type: "Domain", id: "LIST" },
      ],
    }),

    archiveDomain: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/domains/${id}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Domain", id },
        { type: "Domain", id: "LIST" },
      ],
    }),

    purgeDomain: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/domains/${id}/purge`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Domain", id },
        { type: "Domain", id: "LIST" },
      ],
    }),
  }),
})

export const {
  useListDomainsQuery,
  useCreateDomainMutation,
  useUpdateDomainMutation,
  useArchiveDomainMutation,
  usePurgeDomainMutation,
} = domainsApi
