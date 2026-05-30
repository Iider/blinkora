import express from 'express';
import passport from './config';
import { prisma } from '../../prisma';
import { authenticator } from 'otplib';
import { getGlobalConfig } from '../../routerTrpc/config';
import { verifyToken, generateToken, generateApiToken } from '../../lib/helper';

const router = express.Router();

router.post('/login', (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!user) {
      if (info && info.requiresTwoFactor) {
        return res.status(200).json({ requiresTwoFactor: true, userId: info.userId });
      }
      return res.status(401).json({ error: info.message || 'Authentication failed' });
    }

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        nickname: user.nickname,
        image: user.image,
      },
      token: user.token,
    });
  })(req, res, next);
});

router.post('/verify-2fa', async (req: any, res) => {
  try {
    const userId = req.body.userId;

    if (!userId || !req.body.code) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const user = await prisma.accounts.findUnique({ where: { id: Number(userId) } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const config = await getGlobalConfig({
      ctx: {
        id: user.id.toString(),
        role: user.role as 'superadmin' | 'user',
        name: user.name,
        sub: user.id.toString(),
        exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        iat: Math.floor(Date.now() / 1000),
      },
    });

    const isValidToken = authenticator.verify({ token: req.body.code, secret: config.twoFactorSecret ?? '' });

    if (!isValidToken) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    const token = await generateToken(user, true);
    const apiToken = await generateApiToken({ id: user.id, name: user.name ?? '', role: user.role });
    await prisma.accounts.update({ where: { id: user.id }, data: { apiToken } });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        nickname: user.nickname,
        image: user.image,
      },
      token,
    });
  } catch (error) {
    console.error('2FA verification error:', error);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

router.get('/profile', async (req: any, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = authHeader.substring(7);
    const decoded = await verifyToken(token);

    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await prisma.accounts.findUnique({ where: { id: Number(decoded.sub) } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        nickname: user.nickname,
        image: user.image,
      },
    });
  } catch (error) {
    console.error('Profile error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
});

router.post('/logout', (req: any, res) => {
  res.json({ message: 'Logout successful' });
});

router.get('/validate-token', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ valid: false, error: 'Token not provided' });
    }

    const token = authHeader.substring(7);
    const decoded = await verifyToken(token);

    if (!decoded) {
      return res.status(401).json({ valid: false, error: 'Invalid token' });
    }

    return res.json({ valid: true, user: decoded });
  } catch (error) {
    console.error('Token validation error:', error);
    return res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

export default router;
