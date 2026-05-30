import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { prisma } from '../../prisma';
import { verifyPassword } from '@prisma/seed';
import { getGlobalConfig } from '../../routerTrpc/config';
import { getNextAuthSecret, generateToken, generateApiToken } from '../../lib/helper';
import { cache } from '@shared/lib/cache';

const CACHE_TTL = 20 * 1000;

export const configureSession = async (app: any) => {
  await initJwtStrategy();
  initLocalStrategy();
  app.use(passport.initialize());
};

const initJwtStrategy = async () => {
  const secretKey = await getNextAuthSecret();

  passport.use(
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: secretKey,
        passReqToCallback: true,
      },
      async (req, jwtPayload, done) => {
        try {
          if (jwtPayload.exp < Math.floor(Date.now() / 1000)) {
            return done(null, false, { message: 'Token expired' });
          }

          const user = await cache.wrap(
            `user_by_id_${jwtPayload.sub}`,
            async () => prisma.accounts.findUnique({ where: { id: Number(jwtPayload.sub) } }),
            { ttl: CACHE_TTL },
          );

          if (!user) {
            return done(null, false, { message: 'User not found' });
          }

          if (!jwtPayload.twoFactorVerified) {
            const config = await getGlobalConfig({
              ctx: {
                id: user.id.toString(),
                role: user.role as 'superadmin' | 'user',
                name: user.name,
                sub: user.id.toString(),
                exp: jwtPayload.exp,
                iat: jwtPayload.iat,
              },
            });

            if (config.twoFactorEnabled) {
              return done(null, false, { requiresTwoFactor: true, userId: user.id });
            }
          }

          return done(null, user);
        } catch (error) {
          return done(error);
        }
      },
    ),
  );
};

const initLocalStrategy = () => {
  passport.use(
    new LocalStrategy(
      {
        usernameField: 'username',
        passwordField: 'password',
      },
      async (username, password, done) => {
        try {
          const users = await cache.wrap(
            `users_by_name_${username}`,
            async () => prisma.accounts.findMany({ where: { name: username } }),
            { ttl: CACHE_TTL },
          );

          if (users.length === 0) {
            return done(null, false, { message: 'User not found' });
          }

          let verifiedUser = undefined;
          for (const candidate of users) {
            if (await verifyPassword(password, candidate.password ?? '')) {
              verifiedUser = candidate;
              break;
            }
          }

          if (!verifiedUser) {
            return done(null, false, { message: 'Incorrect password' });
          }

          const config = await getGlobalConfig({
            ctx: {
              id: verifiedUser.id.toString(),
              role: verifiedUser.role as 'superadmin' | 'user',
              name: verifiedUser.name,
              sub: verifiedUser.id.toString(),
              exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
              iat: Math.floor(Date.now() / 1000),
            },
          });

          if (config.twoFactorEnabled) {
            return done(null, false, { requiresTwoFactor: true, userId: verifiedUser.id });
          }

          const token = await generateToken(verifiedUser, false);
          const apiToken = await generateApiToken({ id: verifiedUser.id, name: verifiedUser.name ?? '', role: verifiedUser.role });
          await prisma.accounts.update({ where: { id: verifiedUser.id }, data: { apiToken } });

          return done(null, { ...verifiedUser, token });
        } catch (error) {
          return done(error);
        }
      },
    ),
  );
};

export default passport;
