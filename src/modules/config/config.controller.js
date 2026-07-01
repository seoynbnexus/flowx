import * as configService from './config.service.js';

export async function getConfig(req, res, next) {
  try {
    if (req.user) {
      const config = await configService.getFullConfig(req.user.id);
      return res.json({ success: true, data: config });
    }

    if (req.tokenProvided) {
      return res.status(401).json({
        success: false,
        message: 'Access token expired or invalid',
        code: 'TOKEN_INVALID',
      });
    }

    const config = await configService.getPublicConfig();
    return res.json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
}
