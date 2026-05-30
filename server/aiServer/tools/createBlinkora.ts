import { userCaller } from '@server/routerTrpc/_app';
import { NoteType } from '@shared/lib/types';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { verifyToken } from '@server/lib/helper';

export const upsertBlinkoraTool = createTool({
  id: 'upsert-blinkora-tool',
  description: 'You are a blinkora assistant. You can create different types of content. "Blinkora" means flash thoughts or sudden inspiration - those fleeting ideas that pop into mind.',
  inputSchema: z.object({
    content: z.string().describe("The content to save. Tag is start with #"),
    type: z.string().optional().default('blinkora').describe('Optional: The type of content: "blinkora" (flash thoughts/sudden ideas/fleeting inspiration - the default), "note" (longer, structured content), or "todo" (tasks to be done)'),
    token: z.string().optional().describe("internal use, do not pass!"),
    workspaceId: z.number().optional().describe("internal use, do not pass!")
  }),
  execute: async ({ context, runtimeContext }) => {
    const accountId = runtimeContext?.get('accountId') || (await verifyToken(context.token))?.sub;
    const workspaceId = Number(runtimeContext?.get('workspaceId') || context.workspaceId);
    
    // Convert string type to NoteType enum
    let noteType: NoteType;
    const typeStr = (context.type || 'blinkora').toLowerCase();
    
    switch (typeStr) {
      case 'note':
      case '1':
        noteType = NoteType.NOTE; // 1
        break;
      case 'todo':
      case '2':
        noteType = NoteType.TODO; // 2
        break;
      case 'blinkora':
      case '0':
      default:
        noteType = NoteType.BLINKORA; // 0
        break;
    }
    
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
      const note = await caller.notes.upsert({
        content: context.content,
        type: noteType,
      })
      return note
    } catch (error) {
      return error.message
    }
  }
});
