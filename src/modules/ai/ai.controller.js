import * as aiService from './ai.service.js';
import { sendSuccess, sendCreated } from '../../../shared/utils/response.utils.js';
import { HTTP_STATUS } from '../../../shared/constants/httpStatus.js';

export async function generate(req, res, next) {
  try {
    const { prompt, type, tone, language, targetLanguage } = req.body;
    const result = await aiService.generateContent(
      req.user.id,
      prompt,
      type,
      tone,
      language,
      targetLanguage
    );
    return sendSuccess(res, result, 'Content generated successfully');
  } catch (error) {
    next(error);
  }
}

export async function save(req, res, next) {
  try {
    const { prompt, type, generatedContent, metadata } = req.body;
    const saved = await aiService.saveContent(
      req.user.id,
      prompt,
      type,
      generatedContent,
      metadata
    );
    return sendCreated(res, saved, 'Content saved to library');
  } catch (error) {
    next(error);
  }
}

export async function history(req, res, next) {
  try {
    const { page, limit, type } = req.query;
    const result = await aiService.getHistory(req.user.id, { page, limit, type });
    return sendSuccess(res, result.items, 'History fetched', HTTP_STATUS.OK);
  } catch (error) {
    next(error);
  }
}

export async function remove(req, res, next) {
  try {
    await aiService.deleteContent(req.params.id, req.user.id);
    return sendSuccess(res, null, 'Content deleted');
  } catch (error) {
    next(error);
  }
}

export async function wallet(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await aiService.getUserWallet(req.user.id, page, limit);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function generateImage(req, res, next) {
  try {
    const { prompt, size, style } = req.body;
    const result = await aiService.generateImage(req.user.id, prompt, size, style);
    return sendSuccess(res, result, 'Image generated successfully');
  } catch (error) {
    next(error);
  }
}

export async function saveImage(req, res, next) {
  try {
    const { prompt, imageUrl, style, size } = req.body;
    const saved = await aiService.saveImage(req.user.id, prompt, imageUrl, style, size);
    return sendCreated(res, saved, 'Image saved to library');
  } catch (error) {
    next(error);
  }
}

export async function listImages(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await aiService.getImages(req.user.id, { page, limit });
    return sendSuccess(res, result.items, 'Images fetched');
  } catch (error) {
    next(error);
  }
}

export async function removeImage(req, res, next) {
  try {
    await aiService.deleteImage(req.params.id, req.user.id);
    return sendSuccess(res, null, 'Image deleted');
  } catch (error) {
    next(error);
  }
}


