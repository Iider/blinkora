import { router, authProcedure } from '@server/middleware';
import { z } from 'zod';
import { exportBackupArchive } from '@server/lib/backup';

export const taskRouter = router({
  exportMarkdown: authProcedure
    .input(z.object({
      format: z.enum(['markdown', 'json']),
      baseURL: z.string(),
      scope: z.enum(['workspace', 'full']).default('workspace'),
      startDate: z.date().optional(),
      endDate: z.date().optional(),
    })).output(z.object({
      success: z.boolean(),
      downloadUrl: z.string().optional(),
      fileCount: z.number().optional(),
      workspaceCount: z.number().optional(),
      attachmentCount: z.number().optional(),
      missingFileCount: z.number().optional(),
      scope: z.enum(['workspace', 'full']).optional(),
      error: z.string().optional()
    }))
    .mutation(async ({ input, ctx }) => {
      return exportBackupArchive({
        accountId: Number(ctx.id),
        workspaceId: Number(ctx.workspaceId),
        scope: input.scope,
        format: input.format,
        startDate: input.startDate,
        endDate: input.endDate,
      });
    }),
});
