"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportSchema = exports.uploadUrlSchema = void 0;
// src/validation/reportSchema.ts
const zod_1 = require("zod");
exports.uploadUrlSchema = zod_1.z.object({
    filename: zod_1.z.string().max(150),
    type: zod_1.z.enum(['image', 'video', 'document']),
});
exports.reportSchema = zod_1.z.object({
    state: zod_1.z.string().min(2).max(50),
    city: zod_1.z.string().min(1).max(80),
    address: zod_1.z.string().min(3).max(150),
    description: zod_1.z.string().min(10).max(1000),
    mediaKeys: zod_1.z.array(zod_1.z.string()).max(5).default([]),
    informant: zod_1.z
        .object({
        name: zod_1.z.string().max(120).optional(),
        phone: zod_1.z.string().max(20).optional(),
        email: zod_1.z.string().email().max(120).optional().or(zod_1.z.literal('')),
        address: zod_1.z.string().max(300).optional(),
    })
        .optional(),
});
