import { Router } from 'express';
import * as controller from './auth.controller.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import {
  registerSchema,
  sendRegistrationOtpSchema,
  verifyRegistrationOtpSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
  googleAuthSchema,
} from './auth.validation.js';

const router = Router();

router.post('/send-registration-otp', validate(sendRegistrationOtpSchema), controller.sendRegistrationOtp);
router.post('/verify-registration-otp', validate(verifyRegistrationOtpSchema), controller.verifyRegistrationOtp);
router.post('/register', validate(registerSchema), controller.register);
router.post('/login', validate(loginSchema), controller.login);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);
router.post('/forgot-password', validate(forgotPasswordSchema), controller.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), controller.resetPassword);
router.post('/send-otp', validate(sendOtpSchema), controller.sendOtp);
router.post('/verify-otp', validate(verifyOtpSchema), controller.verifyOtp);
router.post('/oauth/google', validate(googleAuthSchema), controller.googleAuth);

export default router;
