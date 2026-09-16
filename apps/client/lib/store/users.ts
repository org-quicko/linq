import type { ApiKey, ApiKeyCreated, Page, Role, User } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

export type Me = { user: { id: string; name: string; role: Role }; keyPrefix: string | null }

export const usersApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    getMe: build.query<Me, void>({
      query: () => ({ path: "/v1/me" }),
    }),

    listUsers: build.query<Page<User>, { limit?: number }>({
      query: (params) => ({ path: `/v1/users${qs(params)}` }),
      providesTags: (result) =>
        result
          ? [
              ...result.data.map((user) => ({ type: "User" as const, id: user.id })),
              { type: "User" as const, id: "LIST" },
            ]
          : [{ type: "User" as const, id: "LIST" }],
    }),

    createUser: build.mutation<User, { name: string; email: string | null; role: Role }>({
      query: (body) => ({ path: "/v1/users", method: "POST", body }),
      invalidatesTags: [{ type: "User", id: "LIST" }],
    }),

    updateUser: build.mutation<User, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ path: `/v1/users/${id}`, method: "PATCH", body }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "User", id },
        { type: "User", id: "LIST" },
      ],
    }),

    listKeys: build.query<ApiKey[], string>({
      query: (userId) => ({ path: `/v1/users/${userId}/keys` }),
      providesTags: (_result, _error, userId) => [{ type: "Key", id: userId }],
    }),

    mintKey: build.mutation<ApiKeyCreated, { userId: string; label: string }>({
      query: ({ userId, label }) => ({
        path: `/v1/users/${userId}/keys`,
        method: "POST",
        body: { label },
      }),
      invalidatesTags: (_result, _error, { userId }) => [{ type: "Key", id: userId }],
    }),

    revokeKey: build.mutation<void, { userId: string; keyId: string }>({
      query: ({ keyId }) => ({ path: `/v1/keys/${keyId}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, { userId }) => [{ type: "Key", id: userId }],
    }),
  }),
})

export const {
  useGetMeQuery,
  useListUsersQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useListKeysQuery,
  useMintKeyMutation,
  useRevokeKeyMutation,
} = usersApi
