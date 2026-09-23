import type { ApiKey, ApiKeyCreated, ApiKeySummary, Page, Role } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

/** The calling key. There is no user behind it — see docs/adr/0011. */
export type Me = ApiKey

export const keysApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    getMe: build.query<Me, void>({
      query: () => ({ path: "/v1/me" }),
    }),

    /** Below admin the server returns only `{ id, name, role }`. */
    listKeys: build.query<Page<ApiKey | ApiKeySummary>, { limit?: number }>({
      query: (params) => ({ path: `/v1/keys${qs(params)}` }),
      providesTags: (result) =>
        result
          ? [
              ...result.data.map((key) => ({ type: "Key" as const, id: key.id })),
              { type: "Key" as const, id: "LIST" },
            ]
          : [{ type: "Key" as const, id: "LIST" }],
    }),

    mintKey: build.mutation<ApiKeyCreated, { name: string; role: Role; expires_at?: string | null }>(
      {
        query: (body) => ({ path: "/v1/keys", method: "POST", body }),
        invalidatesTags: [{ type: "Key", id: "LIST" }],
      },
    ),

    updateKey: build.mutation<ApiKey, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ path: `/v1/keys/${id}`, method: "PATCH", body }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Key", id },
        { type: "Key", id: "LIST" },
      ],
    }),

    revokeKey: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/keys/${id}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Key", id },
        { type: "Key", id: "LIST" },
      ],
    }),
  }),
})

export const {
  useGetMeQuery,
  useListKeysQuery,
  useMintKeyMutation,
  useUpdateKeyMutation,
  useRevokeKeyMutation,
} = keysApi
