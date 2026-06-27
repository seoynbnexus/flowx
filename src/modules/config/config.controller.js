import * as configService from './config.service.js';

export async function getConfig(req, res, next) {
  try {
    if (req.user) {
      const config = await configService.getFullConfig(req.user.id);
      return res.json({ success: true, data: config });
    }

    const config = await configService.getPublicConfig();
    return res.json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
}
