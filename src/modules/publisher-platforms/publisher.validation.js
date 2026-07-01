import { z } from 'zod';

const instagramRegex = /^(https?:\/\/)?(www\.)?instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?$/;
const facebookRegex = /^(https?:\/\/)?(www\.)?(facebook|fb)\.com\/([a-zA-Z0-9.]{5,50})\/?$/;

export const submitAccountSchema = z.object({
  platformCode: z.enum(['instagram', 'facebook'], 'Platform must be instagram or facebook'),
  profileUrl: z.string().min(1, 'Profile URL is required').max(500),
}).refine(data => {
  if (data.platformCode === 'instagram') return instagramRegex.test(data.profileUrl);
  if (data.platformCode === 'facebook') return facebookRegex.test(data.profileUrl);
  return false;
}, { message: 'Invalid profile URL format for the selected platform' });

export const deleteAccountSchema = z.object({
  id: z.string().uuid('Invalid account ID'),
});

export const listAccountsQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const verifyAccountSchema = z.object({
  status: z.enum(['verified', 'rejected']),
});

export const oAuthPlatformQuerySchema = z.object({
  platformCode: z.enum(['instagram', 'facebook']).optional().default('instagram'),
});
