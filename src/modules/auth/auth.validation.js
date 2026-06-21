import { z } from 'zod';

const phoneRegex = /^[1-9]\d{9,14}$/;

export const registerSchema = z.object({
  verificationToken: z.string().min(1, 'Verification token is required'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  firstName: z.string().min(1, 'First name is required').max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().regex(phoneRegex, 'Invalid phone format. Use E.164 (e.g. +911234567890)').optional(),
  role: z.enum(['client', 'publisher']).optional().default('publisher'),
});

export const sendRegistrationOtpSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
});

export const verifyRegistrationOtpSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be a 6-digit code'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  deviceName: z.string().max(255).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

export const sendOtpSchema = z.object({
  phone: z.string().regex(phoneRegex, 'Invalid phone format. Use E.164 (e.g. +911234567890)'),
  purpose: z.enum(['phone_verification', 'login', 'password_reset']),
});

export const verifyOtpSchema = z.object({
  phone: z.string().regex(phoneRegex, 'Invalid phone format. Use E.164 (e.g. +911234567890)'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
  purpose: z.enum(['phone_verification', 'login', 'password_reset']),
});

export const googleAuthSchema = z.object({
  accessToken: z.string().min(1, 'Google access token is required'),
});
