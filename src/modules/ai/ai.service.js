import * as repo from './ai.repository.js';
import { generateUuid, bufferToUuid } from '../../../shared/utils/uuid.utils.js';
import { getLLM, getProviderInfo } from '../../../shared/ai/provider.js';
import { getSystemPrompt, buildPrompt } from '../../../shared/ai/prompt-templates.js';
import { moderatePrompt, moderateOutput } from '../../../shared/ai/moderation.service.js';
import { getPolicy } from '../../../shared/ai/policy-loader.js';
import { calculateCost, calculateImageCost } from '../../../shared/ai/pricing.js';
import { AI_CONTENT_TYPES, getMarkupCoins, getImageBaseCost } from './ai.config.js';
import { ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js';
import { getImageLLM } from '../../../shared/ai/image-provider.js';
import fs from 'fs/promises';
import path from 'path';

const { HumanMessage, SystemMessage } = await import('@langchain/core/messages');

export async function generateContent(userId, prompt, type, tone, language, targetLanguage) {
  const markupCoins = await getMarkupCoins();

  const blocked = await repo.findBlockedStatus(userId);
  if (blocked) {
    throw new ForbiddenError('AI content generation has been blocked for your account. Contact support.');
  }

  const moderation = await moderatePrompt(prompt, userId);
  await repo.logUsage(userId, prompt, type, !moderation.allowed, moderation.reason, 0, 0);

  if (!moderation.allowed) {
    const violations = await repo.countAbuseViolations(userId, getPolicy().abuse?.violation_window_hours || 24);
    const threshold = getPolicy().abuse?.violation_threshold || 5;

    if (violations >= threshold) {
      await repo.blockGeneration(userId);
    }

    const accountThreshold = getPolicy().abuse?.auto_block_account_at || 10;
    if (violations >= accountThreshold) {
      const { default: authRepo } = await import('../auth/auth.repository.js');
      await authRepo.updateUserStatus(userId, 'blocked');
      throw new ForbiddenError('Account blocked due to repeated policy violations. Contact support.');
    }

    throw new ValidationError(moderation.reason || 'Prompt violates content policy', null, 'CONTENT_POLICY_VIOLATION');
  }

  const subService = await import('../subscriptions/subscription.service.js');
  await subService.canPerform(userId, 'ai_content');

  const llm = await getLLM();
  const systemPrompt = getSystemPrompt();
  const variables = { prompt, tone: tone || 'professional', language: language || 'en' };
  if (type === AI_CONTENT_TYPES.TRANSLATE) {
    variables.targetLanguage = targetLanguage || 'Spanish';
  }
  const userPrompt = buildPrompt(type, variables);

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  const content = response.content;
  const tokenUsage = response.usage_metadata || { input_tokens: 0, output_tokens: 0 };
  const totalTokens = (tokenUsage.input_tokens || 0) + (tokenUsage.output_tokens || 0);

  const outputCheck = await moderateOutput(content, userId);
  if (!outputCheck.allowed) {
    await repo.logUsage(userId, prompt, type, true, 'Generated content flagged by policy', totalTokens, 0);
    throw new ValidationError('Generated content did not pass safety checks. Please try a different prompt.', null, 'OUTPUT_POLICY_VIOLATION');
  }

  const cost = calculateCost(totalTokens, markupCoins);

  const coinService = await import('../../../shared/services/coin.service.js');
  await coinService.spend(userId, cost, 'ai_generation', null, `AI ${type} generation`);

  await repo.logUsage(userId, prompt, type, false, null, totalTokens, cost);

  const available = await coinService.getAvailable(userId);
  const providerInfo = getProviderInfo();

  return {
    content,
    metadata: {
      type,
      tone: tone || 'professional',
      language: language || 'en',
      model: providerInfo.model,
      provider: providerInfo.provider,
      promptTokens: tokenUsage.input_tokens || 0,
      completionTokens: tokenUsage.output_tokens || 0,
    },
    cost,
    balanceRemaining: available.total,
  };
}

export async function saveContent(userId, prompt, type, generatedContent, metadata) {
  const saved = await repo.createGeneratedContent(
    userId,
    prompt,
    type,
    generatedContent,
    0,
    0,
    0,
    { ...metadata, savedAt: new Date().toISOString() }
  );
  return saved;
}

export async function getHistory(userId, queryParams) {
  return repo.findContentByUserId(userId, queryParams);
}

export async function deleteContent(id, userId) {
  await repo.deleteContent(id, userId);
}

export async function getUserWallet(userId, page = 1, limit = 20) {
  const [coinInfo, transactions] = await Promise.all([
    import('../../../shared/services/coin.service.js').then(m => m.getAvailable(userId)),
    repo.findTransactions(userId, { page, limit }),
  ]);
  return {
    balance: coinInfo.total,
    monthlyRemaining: coinInfo.monthlyRemaining,
    topupBalance: coinInfo.topupBalance,
    monthlyLimit: coinInfo.limit,
    monthlyUsed: coinInfo.used,
    periodStart: coinInfo.periodStart,
    periodEnd: coinInfo.periodEnd,
    transactions: transactions.map(t => ({
      id: bufferToUuid(t.id),
      label: t.label,
      amount: t.amount,
      type: t.type,
      created_at: t.created_at,
    })),
  };
}

async function checkAbuseAndBlock(userId, prompt, type) {
  const blocked = await repo.findBlockedStatus(userId);
  if (blocked) {
    throw new ForbiddenError('AI generation has been blocked for your account. Contact support.');
  }

  const moderation = await moderatePrompt(prompt, userId);
  await repo.logUsage(userId, prompt, type, !moderation.allowed, moderation.reason, 0, 0);

  if (!moderation.allowed) {
    const violations = await repo.countAbuseViolations(userId, getPolicy().abuse?.violation_window_hours || 24);
    const threshold = getPolicy().abuse?.violation_threshold || 5;

    if (violations >= threshold) {
      await repo.blockGeneration(userId);
    }

    const accountThreshold = getPolicy().abuse?.auto_block_account_at || 10;
    if (violations >= accountThreshold) {
      const { default: authRepo } = await import('../auth/auth.repository.js');
      await authRepo.updateUserStatus(userId, 'blocked');
      throw new ForbiddenError('Account blocked due to repeated policy violations. Contact support.');
    }

    throw new ValidationError(moderation.reason || 'Prompt violates content policy', null, 'CONTENT_POLICY_VIOLATION');
  }

  return moderation;
}

export async function generateImage(userId, prompt, size = '1024x1024', style) {
  const markupCoins = await getMarkupCoins();
  const imageBaseCost = await getImageBaseCost();
  const cost = calculateImageCost(imageBaseCost, markupCoins);

  await checkAbuseAndBlock(userId, prompt, 'image');

  const subService = await import('../subscriptions/subscription.service.js');
  await subService.canPerform(userId, 'ai_image');

  const coinService = await import('../../../shared/services/coin.service.js');
  await coinService.spend(userId, cost, 'ai_image', null, 'AI image generation');

  const provider = await getImageLLM();
  const imageUrl = await provider.generate(prompt, { size, style });

  await repo.logUsage(userId, prompt, 'image', false, null, 0, cost);

  const available = await coinService.getAvailable(userId);
  const providerInfo = provider.getProviderInfo();

  return {
    imageUrl,
    cost,
    balanceRemaining: available.total,
    metadata: {
      ...providerInfo,
      size,
      style: style || null,
    },
  };
}

export async function saveImage(userId, prompt, imageUrl, style, size) {
  const imageId = generateUuid();
  const userDir = path.join(process.cwd(), 'public', 'ai_user_image', userId);
  await fs.mkdir(userDir, { recursive: true });
  const fileName = `${imageId}.png`;
  const filePath = path.join(userDir, fileName);

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error('Failed to download generated image');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);

  const storedUrl = `/ai_user_image/${userId}/${fileName}`;

  const saved = await repo.createGeneratedImage(userId, prompt, storedUrl, style, size, 0, {
    savedAt: new Date().toISOString(),
    originalUrl: imageUrl,
  });

  return { ...saved, image_url: storedUrl };
}

export async function getImages(userId, queryParams) {
  return repo.findImagesByUserId(userId, queryParams);
}

export async function deleteImage(id, userId) {
  const row = await repo.deleteImage(id, userId);
  if (row?.image_url) {
    const filePath = path.join(process.cwd(), 'public', row.image_url);
    await fs.unlink(filePath).catch(() => {});
  }
}


