import { ValidationError } from '../errors/AppError.js';

export function validate(schema, source = 'body') {
  return async (req, _res, next) => {
    try {
      const data = await schema.parseAsync(req[source]);
      req[source] = data;
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
