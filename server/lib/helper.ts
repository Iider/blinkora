import { authenticator } from 'otplib';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@server/prisma';
import { User } from '@server/context';
import { Request as ExpressRequest } from 'express';

export function generateTOTP(): string {
  return authenticator.generateSecret();
}

export function generateTOTPQRCode(username: string, secret: string): string {
  return authenticator.keyuri(username, 'Blinkora', secret);
}

export function verifyTOTP(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch (err) {
    return false;
  }
}

let isLoading = false;

export const getNextAuthSecret = async () => {
  const configKey = 'JWT_SECRET';
  let secret = process.env.JWT_SECRET;
  if (isLoading) {
    return secret!;
  }
  if (!secret || secret === 'my_ultra_secure_nextauth_secret') {
    const savedSecret = await prisma.config.findFirst({
      where: { key: configKey },
    });
    if (savedSecret) {
      // @ts-ignore legacy config payload shape
      secret = savedSecret.config.value as string;
    } else {
      const newSecret = crypto.randomBytes(32).toString('base64');
      await prisma.config.create({
        data: {
          key: configKey,
          config: { value: newSecret },
        },
      });
      secret = newSecret;
    }
  }
  isLoading = false;
  return secret;
};

export const generateApiToken = async (user: { id: number; name: string; role: string }, permissions?: string[]) => {
  const secret = await getNextAuthSecret();
  return jwt.sign(
    {
      role: user.role,
      name: user.name,
      sub: user.id.toString(),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 100,
      iat: Math.floor(Date.now() / 1000),
      permissions,
    },
    secret,
  );
};

export const generateToken = async (user: any, twoFactorVerified = false) => {
  const secret = await getNextAuthSecret();
  return jwt.sign(
    {
      sub: user.id,
      name: user.name,
      role: user.role || 'user',
      twoFactorVerified,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      iat: Math.floor(Date.now() / 1000),
    },
    secret,
    { algorithm: 'HS256' },
  );
};

export const verifyToken = async (token?: string | null) => {
  if (!token) return null;
  const secret = await getNextAuthSecret();
  try {
    const decoded = jwt.verify(token, secret) as User;
    return decoded;
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
};

export const getTokenFromRequest = async (req: ExpressRequest) => {
  try {
    if (req.headers && typeof req.headers === 'object') {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        const tokenData = await verifyToken(token);
        if (tokenData) return { ...tokenData, id: tokenData.sub, token };
      }
    }

    if (req.query && req.query.token) {
      const token = req.query.token as string;
      const tokenData = await verifyToken(token);
      if (tokenData) return { ...tokenData, id: tokenData.sub, token };
    }

    return null;
  } catch (error) {
    console.error('Token retrieval error:', error);
    return null;
  }
};

export const getAllPathTags = async () => {
  const flattenTags = await prisma.tag.findMany();
  const hasHierarchy = flattenTags.some((tag) => tag.parent != null);
  if (hasHierarchy) {
    const buildHashTagTreeFromDb = (tags: any[]) => {
      const tagMap = new Map();
      const rootNodes: any[] = [];
      tags.forEach((tag) => {
        tagMap.set(tag.id, { ...tag, children: [] });
      });
      tags.forEach((tag) => {
        if (tag.parent) {
          const parentNode = tagMap.get(tag.parent);
          if (parentNode) {
            parentNode.children.push(tagMap.get(tag.id));
          } else {
            rootNodes.push(tagMap.get(tag.id));
          }
        } else {
          rootNodes.push(tagMap.get(tag.id));
        }
      });
      return rootNodes;
    };

    const getFullPath = (node: any, path = ''): { id: number; name: string }[] => {
      const currentPath = path ? `${path}/${node.name}` : node.name;
      let results = [{ id: node.id, name: currentPath }];
      node.children.forEach((child: any) => {
        results = results.concat(getFullPath(child, currentPath));
      });
      return results;
    };

    return buildHashTagTreeFromDb(flattenTags).flatMap((node) => getFullPath(node));
  }
  return flattenTags.map((tag) => ({ id: tag.id, name: tag.name }));
};
