import type { LinkTree, LinkTreeCreate, LinkTreePatch } from "@linq/shared"
import { apiSlice } from "./api"

/**
 * Link Trees. Listing, archiving, restoring and purging one go through the
 * `links` endpoints, since a Link Tree is a Link; this slice covers only the
 * page itself. Tags share the "Link" type, so a save here refreshes the
 * Link Trees list, the sidebar counts and Short links (which gains a Link for
 * every URL Item) without a tag type of its own.
 */
export const linkTreesApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    getLinkTree: build.query<LinkTree, string>({
      query: (id) => ({ path: `/v1/link-trees/${id}` }),
      providesTags: (_result, _error, id) => [{ type: "Link", id: `${id}-tree` }],
    }),

    createLinkTree: build.mutation<LinkTree, LinkTreeCreate>({
      query: (body) => ({ path: "/v1/link-trees", method: "POST", body }),
      invalidatesTags: [{ type: "Link", id: "LIST" }],
    }),

    updateLinkTree: build.mutation<LinkTree, { id: string; body: LinkTreePatch }>({
      query: ({ id, body }) => ({ path: `/v1/link-trees/${id}`, method: "PATCH", body }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Link", id },
        { type: "Link", id: `${id}-tree` },
        { type: "Link", id: "LIST" },
      ],
    }),
  }),
})

export const { useGetLinkTreeQuery, useCreateLinkTreeMutation, useUpdateLinkTreeMutation } =
  linkTreesApi
