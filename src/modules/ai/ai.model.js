import { z } from 'zod';
import { AI_CONTENT_TYPES } from './ai.config.js';

export const generateSchema = z.object({
  prompt: z.string().min(3, 'Prompt must be at least 3 characters').max(1000, 'Prompt too long'),
  type: z.nativeEnum(AI_CONTENT_TYPES),
  tone: z.enum(['professional', 'casual', 'luxury', 'playful', 'urgent']).default('professional'),
  language: z.string().min(2).max(10).default('en'),
  targetLanguage: z.string().min(2).max(50).optional(),
});

export const saveSchema = z.object({
  prompt: z.string().min(1),
  type: z.nativeEnum(AI_CONTENT_TYPES),
  generatedContent: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});

export const historyQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  type: z.nativeEnum(AI_CONTENT_TYPES).optional(),
});

export const VALID_TONES = [
  { value: 'professional', label: 'Professional' },
  { value: 'casual', label: 'Casual' },
  { value: 'luxury', label: 'Luxury' },
  { value: 'playful', label: 'Playful' },
  { value: 'urgent', label: 'Urgent' },
];

export const IMAGE_SIZES = ['512x512', '1024x1024', '1024x1792', '1792x1024'];
export const IMAGE_STYLES = ['photorealistic', 'digital-art', 'cinematic', 'anime', 'oil-painting', 'sketch', '3d-render', 'watercolor'];

export const generateImageSchema = z.object({
  prompt: z.string().min(3, 'Prompt must be at least 3 characters').max(1000, 'Prompt too long'),
  size: z.enum(IMAGE_SIZES).default('1024x1024'),
  style: z.enum(IMAGE_STYLES).optional(),
});

export const saveImageSchema = z.object({
  prompt: z.string().min(1),
  imageUrl: z.string().min(1),
  style: z.string().optional(),
  size: z.string().default('1024x1024'),
});

export const imageQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const CONTENT_TYPE_LABELS = {
  caption: 'Marketing Caption',
  hashtags: 'Hashtag Generator',
  content: 'Full Ad Copy',
  rewrite: 'Professional Rewrite',
  translate: 'AI Translate',
};
