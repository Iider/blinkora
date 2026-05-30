import { z } from 'zod';
import { router, publicProcedure } from '../middleware';
import packageJson from '../../package.json';
import { cache } from '@shared/lib/cache';
import { unfurl } from 'unfurl.js';
import { Metadata } from 'unfurl.js/dist/types';
import pLimit from 'p-limit';
import { prisma } from '../prisma';

const limit = pLimit(5);

export const publicRouter = router({
  serverVersion: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/public/server-version', summary: 'Get server version', tags: ['Public'] } })
    .input(z.void())
    .output(z.string())
    .query(async function () {
      return await cache.wrap(
        'server-version',
        async () => {
          return packageJson.version;
        },
        { ttl: 10 * 1000 },
      );
    }),
  linkPreview: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/public/link-preview', summary: 'Get a link preview info', tags: ['Public'] } })
    .input(z.object({ url: z.string() }))
    .output(
      z.union([
        z.object({
          title: z.string(),
          favicon: z.string(),
          description: z.string(),
        }),
        z.null(),
      ]),
    )
    .query(async function ({ input }) {
      return cache.wrap(
        input.url,
        async () => {
          try {
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(console.error('timeout')), 5000);
            });
            const fetchPromise = limit(async () => {
              const result: Metadata = await unfurl(input.url);
              return {
                title: result?.title ?? '',
                favicon: result?.favicon ?? '',
                description: result?.description ?? '',
              };
            });
            const result: any = await Promise.race([fetchPromise, timeoutPromise]);
            return result;
          } catch (error) {
            console.error('Link preview error:', error);
            return {
              title: '',
              favicon: '',
              description: '',
            };
          }
        },
        { ttl: 60 * 60 * 1000 },
      );
    }),
  siteInfo: publicProcedure
    .meta({
      openapi: { method: 'GET', path: '/v1/public/site-info', summary: 'Get site info', tags: ['Public'] },
    })
    .input(
      z
        .object({
          id: z.number().nullable().optional(),
        })
        .optional(),
    )
    .output(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        image: z.string().optional(),
        description: z.string().optional(),
        role: z.string().optional(),
      }),
    )
    .query(async function ({ input }) {
      return cache.wrap(
        input?.id ? input.id.toString() : 'superadmin-site-info',
        async () => {
          if (!input?.id || input?.id === null) {
            const superAdmin = await prisma.accounts.findFirst({ where: { role: 'superadmin' } });
            return {
              id: Number(superAdmin?.id),
              name: superAdmin?.nickname ?? superAdmin?.name ?? '',
              image: superAdmin?.image ?? '',
              description: superAdmin?.description ?? '',
              role: 'superadmin',
            };
          }
          const account = await prisma.accounts.findFirst({ where: { id: Number(input?.id) } });
          return {
            id: Number(account?.id),
            name: account?.nickname ?? account?.name ?? '',
            image: account?.image ?? '',
            description: account?.description ?? '',
            role: account?.role ?? 'user',
          };
        },
        { ttl: 1000 * 60 * 5 },
      ); // 5 minutes
    }),
});
