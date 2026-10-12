// src/validation/reportSchema.ts
import { z } from 'zod';

export const uploadUrlSchema = z.object({
  filename: z.string().max(150),
  type: z.enum(['image', 'video', 'document']),
});

// Keys are only ever minted by /upload-url as reports/<uuid>.<ext>. Enforcing the exact
// shape stops a client from attaching arbitrary bucket paths to a report.
const MEDIA_KEY = /^reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|mp4|mov|pdf|doc|docx)$/;

export const reportSchema = z.object({
  state: z.string().min(2).max(50),
  city: z.string().min(1).max(80),
  address: z.string().min(3).max(150),
  description: z.string().min(10).max(1000),
  mediaKeys: z
    .array(z.string().regex(MEDIA_KEY, 'Invalid media key'))
    .min(1, 'At least one piece of evidence is required')
    .max(5),
  informant: z
    .object({
      name: z.string().max(120).optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(120).optional().or(z.literal('')),
      address: z.string().max(300).optional(),
    })
    .optional(),
});

export type ReportInput = z.infer<typeof reportSchema>;
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;