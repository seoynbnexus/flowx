import { ValidationError } from '../errors/AppError.js';

export function validate(schema, source = 'body') {
  return async (req, _res, next) => {
    try {
      const data = await schema.parseAsync(req[source]);
      if (source === 'query') {
        for (const key of Object.keys(req.query)) {
          delete req.query[key];
        }
        Object.assign(req.query, data);
      } else {
        req[source] = data;
      }
      next();
    } catch (error) {
      if (error.name === 'ZodError') {
        const formatted = error.issues.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        next(new ValidationError('Validation failed', formatted));
      } else {
        next(error);
      }
    }
  };
}
