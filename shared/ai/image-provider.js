const IMAGE_PROVIDER = process.env.AI_IMAGE_PROVIDER || process.env.AI_PROVIDER || 'gemini';
const API_KEY = process.env.AI_API_KEY;
const MODEL = process.env.AI_IMAGE_MODEL || 'black-forest-labs/flux-1.1-pro';

function extractImageUrl(content) {
  const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
  if (mdMatch?.[1]) return mdMatch[1];

  const urlMatch = content.match(/(https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp))/i);
  if (urlMatch?.[1]) return urlMatch[1];

  if (content.startsWith('http') && content.length < 500) return content;

  throw new Error(`Model returned text instead of an image: "${content.substring(0, 120)}..."`);
}

const PROVIDER_FACTORIES = {
  openai: async () => {
    return {
      generate: async (prompt, { size, style } = {}) => {
        const baseURL = process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1';
        const fullPrompt = style ? `${style}: ${prompt}` : prompt;
        const isDalle = MODEL.startsWith('openai/');

        if (isDalle) {
          const resp = await fetch(`${baseURL}/images/generations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
              model: MODEL,
              prompt: fullPrompt,
              n: 1,
              size: size || '1024x1024',
            }),
          });
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Image generation failed: ${resp.status} ${text}`);
          }
          const data = await resp.json();
          return data.data[0].url;
        }

        const resp = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: fullPrompt }],
            n: 1,
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Image generation failed: ${resp.status} ${text}`);
        }
        const data = await resp.json();
        return extractImageUrl(data.choices[0].message.content);
      },
      getProviderInfo: () => ({ provider: IMAGE_PROVIDER, model: MODEL, type: 'image' }),
    };
  },

  gemini: async () => {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(API_KEY);
    const genModel = genAI.getGenerativeModel({
      model: MODEL || 'gemini-2.0-flash',
      generationConfig: { responseModalities: ['Text', 'Image'] },
    });
    return {
      generate: async (prompt, { size, style } = {}) => {
        const fullPrompt = style ? `${style}: ${prompt}` : prompt;
        const result = await genModel.generateContent(fullPrompt);
        const parts = result.response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData) {
            return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          }
        }
        throw new Error('Gemini did not return an image');
      },
      getProviderInfo: () => ({ provider: IMAGE_PROVIDER, model: MODEL, type: 'image' }),
    };
  },

  midjourney: async () => {
    throw new Error('Midjourney image generation not yet implemented');
  },
};

let cachedProvider = null;

export async function getImageLLM() {
  if (cachedProvider) return cachedProvider;

  const factory = PROVIDER_FACTORIES[IMAGE_PROVIDER];
  if (!factory) {
    throw new Error(`Unknown AI image provider: ${IMAGE_PROVIDER}. Supported: ${Object.keys(PROVIDER_FACTORIES).join(', ')}`);
  }

  cachedProvider = await factory();
  return cachedProvider;
}

export function resetImageLLM() {
  cachedProvider = null;
}
