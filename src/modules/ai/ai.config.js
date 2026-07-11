import { queryOne } from '../../../shared/database/connection.js';

export const AI_CONFIG = {
  provider: process.env.AI_PROVIDER || 'gemini',
  apiKey: process.env.AI_API_KEY,
  model: process.env.AI_MODEL || 'gemini-2.0-flash',
  temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
  maxTokens: parseInt(process.env.AI_MAX_TOKENS || '1024', 10),
};

export const AI_LIMITS = {
  maxPromptLength: parseInt(process.env.AI_MAX_PROMPT_LENGTH || '1000', 10),
  rateLimitRpm: parseInt(process.env.AI_RATE_LIMIT_RPM || '30', 10),
};

export const AI_CONTENT_TYPES = Object.freeze({
  CAPTION: 'caption',
  HASHTAGS: 'hashtags',
  CONTENT: 'content',
  REWRITE: 'rewrite',
  TRANSLATE: 'translate',
});

let cachedMarkup = null;

export async function getMarkupCoins() {
  if (cachedMarkup !== null) return cachedMarkup;
  try {
    const row = await queryOne(
      "SELECT config_value FROM app_config WHERE config_key = 'ai_markup_coins'"
    );
    cachedMarkup = row ? JSON.parse(row.config_value) : 200;
  } catch {
    cachedMarkup = 200;
  }
  return cachedMarkup;
}

export function invalidateMarkupCache() {
  cachedMarkup = null;
}

export const IMAGE_STYLES = Object.freeze([
  'photorealistic',
  'digital-art',
  'cinematic',
  'anime',
  'oil-painting',
  'sketch',
  '3d-render',
  'watercolor',
]);

export const IMAGE_SIZES = Object.freeze([
  '512x512',
  '1024x1024',
  '1024x1792',
  '1792x1024',
]);

let cachedImageBaseCost = null;

export async function getImageBaseCost() {
  if (cachedImageBaseCost !== null) return cachedImageBaseCost;
  try {
    const row = await queryOne(
      "SELECT config_value FROM app_config WHERE config_key = 'ai_image_base_cost'"
    );
    cachedImageBaseCost = row ? JSON.parse(row.config_value) : 500;
  } catch {
    cachedImageBaseCost = 500;
  }
  return cachedImageBaseCost;
}

export function invalidateImageBaseCache() {
  cachedImageBaseCost = null;
}
