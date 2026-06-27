import { z } from 'zod';
import { USER_STATUS } from '../../../shared/constants/index.js';

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().max(100).optional(),
  avatarUrl: z.string().url().max(2048).optional().nullable(),
  countryCode: z.string().length(2).optional(),
  state: z.string().regex(/^[A-Za-z\s]+$/, 'State must contain only letters and spaces').max(100).optional(),
  city: z.string().max(100).optional(),
  pincode: z.string().regex(/^[0-9]{6}$/, 'Pincode must be exactly 6 digits').optional(),
  timezone: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateStatusSchema = z.object({
  status: z.enum([USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.BLOCKED]),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Must contain at least one number'),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Must contain at least one number'),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().optional(),
  role: z.enum(['admin', 'publisher', 'client']),
});

export const listUsersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum([USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.BLOCKED, USER_STATUS.PENDING]).optional(),
  search: z.string().max(255).optional(),
});
