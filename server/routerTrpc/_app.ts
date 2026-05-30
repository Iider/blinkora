/**
 * This file contains the root router of your tRPC-backend
 */
import { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { router, t } from '../middleware';
import { Context } from '../context';
import { lazy } from '@trpc/server';
import { noteRouter } from './note';
import { configRouter } from './config';
import { tagRouter } from './tag';
import { userRouter } from './user';
import { attachmentsRouter } from './attachment';
import { publicRouter } from './public';
import { taskRouter } from './task';
import { fontRouter } from './font';
import { commentsRouter } from './comment';
import { workspaceRouter } from './workspace';
export const appRouter = router({
  notes: noteRouter,
  tags: tagRouter,
  users: userRouter,
  attachments: attachmentsRouter,
  config: configRouter,
  public: publicRouter,
  task: taskRouter,
  fonts: fontRouter,
  comments: commentsRouter,
  workspaces: workspaceRouter,
});

export const createCaller = t.createCallerFactory(appRouter);

//not recommend to use this
export const adminCaller = createCaller({ id: '1', name: 'admin', sub: '1', role: 'superadmin', exp: 0, iat: 0 });

export const userCaller = (ctx: Context) => {
  return createCaller(ctx);
};

export type AppRouter = typeof appRouter;
export type RouterOutput = inferRouterOutputs<AppRouter>;
export type RouterInput = inferRouterInputs<AppRouter>;
