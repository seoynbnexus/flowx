import { validatePrompt, validateOutput } from './policy-loader.js';

const MODERATION_ENABLED = process.env.AI_MODERATION_ENABLED === 'true' || false;

export async function moderatePrompt(prompt, userId) {
  const result = validatePrompt(prompt);

  if (result.blocked) {
    return {
      allowed: false,
      reason: result.reason,
      category: result.category,
      severity: result.severity,
      action: result.action || 'block',
      matched: result.matched || null,
      layer: 'policy',
    };
  }

  if (MODERATION_ENABLED) {
    try {
      const aiResult = await aiModerationCheck(prompt);
      if (!aiResult.allowed) {
        return {
          allowed: false,
          reason: aiResult.reason,
          category: aiResult.category,
          severity: 'medium',
          action: 'block',
          layer: 'ai_moderation',
        };
      }
    } catch {
      return { allowed: true, layer: 'bypass' };
    }
  }

  return { allowed: true, layer: 'policy' };
}

export async function moderateOutput(content, userId) {
  const result = validateOutput(content);

  if (result.blocked) {
    return {
      allowed: false,
      reason: result.reason,
      category: result.category,
      severity: result.severity,
      layer: 'output',
    };
  }

  return { allowed: true, layer: 'output' };
}

async function aiModerationCheck(text) {
  const provider = process.env.AI_MODERATION_PROVIDER || 'google';

  if (provider === 'google') {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.AI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: `Classify this text for marketing content safety. Respond with ONLY one word: SAFE or UNSAFE\n\nText: "${text}"` }],
        }],
      });

      const response = result.response.text().trim().toUpperCase();
      if (response === 'UNSAFE') {
        return { allowed: false, reason: 'Content flagged by AI moderation', category: 'ai_moderation' };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'Moderation service error', category: 'ai_moderation' };
    }
  }

  return { allowed: true };
}
