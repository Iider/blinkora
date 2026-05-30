import { userCaller } from '@server/routerTrpc/_app';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { verifyToken } from '@server/lib/helper';

export const deleteBlinkoraTool = createTool({
  id: 'delete-blinkora-tool',
  description: 'you are a blinkora assistant,you can use api to delete blinkora,save to database',
  //@ts-ignore
  inputSchema: z.object({
    ids: z.array(z.number()),
    token: z.string().optional().describe("internal use, do not pass!"),
    workspaceId: z.number().optional().describe("internal use, do not pass!")
  }),
  execute: async ({ context, runtimeContext }) => {
    const accountId = runtimeContext?.get('accountId') || (await verifyToken(context.token))?.sub;
    const workspaceId = Number(runtimeContext?.get('workspaceId') || context.workspaceId);

    try {
      const caller = userCaller({
        id: String(accountId),
        exp: 0,
        iat: 0,
        name: 'admin',
        sub: String(accountId),
        role: 'superadmin',
        workspaceId
      })
      const note = await caller.notes.trashMany({
        ids: context.ids
      })
      return true
    } catch (error) {
      return error.message
    }
  }
});
