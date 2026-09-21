import type { Page, QrCode, QrCodeCreate, QrCodePatch } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

type QrCodeFilters = {
  link_id?: string
  search?: string
  limit?: number
  offset?: number
}

export const qrCodesApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    listQrCodes: build.query<Page<QrCode>, QrCodeFilters>({
      query: (filters) => ({ path: `/v1/qr-codes${qs(filters)}` }),
      providesTags: (result) =>
        result
          ? [
              ...result.data.map((qrCode) => ({ type: "QrCode" as const, id: qrCode.id })),
              { type: "QrCode" as const, id: "LIST" },
            ]
          : [{ type: "QrCode" as const, id: "LIST" }],
    }),

    createQrCode: build.mutation<QrCode, QrCodeCreate>({
      query: (body) => ({ path: "/v1/qr-codes", method: "POST", body }),
      invalidatesTags: [{ type: "QrCode", id: "LIST" }],
    }),

    updateQrCode: build.mutation<QrCode, { id: string; body: QrCodePatch }>({
      query: ({ id, body }) => ({ path: `/v1/qr-codes/${id}`, method: "PATCH", body }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "QrCode", id },
        { type: "QrCode", id: "LIST" },
      ],
    }),

    deleteQrCode: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/qr-codes/${id}`, method: "DELETE" }),
      invalidatesTags: (_result, _error, id) => [
        { type: "QrCode", id },
        { type: "QrCode", id: "LIST" },
      ],
    }),
  }),
})

export const {
  useListQrCodesQuery,
  useCreateQrCodeMutation,
  useUpdateQrCodeMutation,
  useDeleteQrCodeMutation,
} = qrCodesApi
