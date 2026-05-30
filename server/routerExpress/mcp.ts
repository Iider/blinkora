import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getTokenFromRequest } from '@server/lib/helper';
import { prisma } from '@server/prisma';
import { searchBlinkoraTool } from "@server/aiServer/tools/searchBlinkora";
import { upsertBlinkoraTool } from "@server/aiServer/tools/createBlinkora";
import { updateBlinkoraTool } from "@server/aiServer/tools/updateBlinkora";
import { deleteBlinkoraTool } from "@server/aiServer/tools/deleteBlinkora";

const router = express.Router();

// Middleware to parse JSON
router.use(express.json());

// Auth middleware - attaches token to req for downstream handlers
const requireAuth = async (req: any, res: any, next: any) => {
  try {
    const token = await getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.token = token.token;
    req.auth = token;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

const migrateLegacyDataToWorkspace = async (accountId: number, workspaceId: number) => {
  await prisma.notes.updateMany({ where: { accountId, workspaceId: null }, data: { workspaceId } });
  await prisma.tag.updateMany({ where: { accountId, workspaceId: null }, data: { workspaceId } });
  await prisma.attachments.updateMany({ where: { accountId, workspaceId: null }, data: { workspaceId } });
  await prisma.comments.updateMany({ where: { accountId, workspaceId: null }, data: { workspaceId } });
  await prisma.config.updateMany({ where: { userId: accountId, workspaceId: null }, data: { workspaceId } });
  await prisma.noteHistory.updateMany({ where: { accountId, workspaceId: null }, data: { workspaceId } });
};

const resolveWorkspaceId = async (req: any, accountId: number) => {
  const workspaceHeader = req.headers['x-workspace-id'];
  if (workspaceHeader) {
    const ws = await prisma.workspaces.findFirst({
      where: { id: Number(workspaceHeader), accountId },
      select: { id: true }
    });
    if (ws) return ws.id;
  }

  const defaultWs = await prisma.workspaces.findFirst({
    where: { accountId, isDefault: true },
    select: { id: true }
  });
  if (defaultWs) return defaultWs.id;

  const newWs = await prisma.workspaces.create({
    data: { name: '默认工作区', accountId, isDefault: true },
    select: { id: true }
  });
  await migrateLegacyDataToWorkspace(accountId, newWs.id);
  return newWs.id;
};

function serverFactory(token: string, workspaceId: number) {
  const server = new McpServer({
    name: 'blinkora-mcp-server',
    version: '1.0.0',
  });

  // Helper function to create tool with context
  const createToolWithContext = (toolName: string, tool: any) => {
    // Use the shape directly
    const mcpSchema = tool.inputSchema.shape;

    server.registerTool(
      toolName,
      {
        description: tool.description || '',
        inputSchema: mcpSchema
      },
      async (args: any, _extra: any) => {
        try {
          const { ...toolArgs } = args;
          const finalContext = { ...toolArgs, token, workspaceId };
          const result = await tool.execute({ context: finalContext });

          return {
            content: [
              {
                type: "text",
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
              }
            ],
            structuredContent: result
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: errorMessage
              }
            ],
            structuredContent: { success: false, error: errorMessage }
          };
        }
      }
    );
  };

  // Register all Blinkora tools
  createToolWithContext('searchBlinkora', searchBlinkoraTool);
  createToolWithContext('upsertBlinkora', upsertBlinkoraTool);
  createToolWithContext('updateBlinkora', updateBlinkoraTool);
  createToolWithContext('deleteBlinkora', deleteBlinkoraTool);

  return server;
}

const transports: Record<string, SSEServerTransport> = {};

// Mount the handlers with auth
router.get('/sse', requireAuth, async (req, res, next) => {
  const token = (req as any).token as string;
  const auth = (req as any).auth;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const accountId = Number(auth.id || auth.sub);
    const workspaceId = await resolveWorkspaceId(req, accountId);
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;

    transport.onerror = (error) => {
      console.error(`[MCP SSE][${sessionId || 'unknown'}]`, error);
    };
    transport.onclose = () => {
      console.log(`[MCP SSE] Transport closed: ${sessionId}`);
      delete transports[sessionId];
    };
    transports[sessionId] = transport;
    res.on('close', () => {
      delete transports[sessionId];
    });

    await serverFactory(token, workspaceId).connect(transport);
  } catch (error) {
    console.error('[MCP SSE] Failed to initialize transport:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    next(error);
  }
});

router.post('/messages', requireAuth, async (req, res, next) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('No transport found for sessionId');
  }

  try {
    await transports[sessionId].handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error(`[MCP SSE][${sessionId}]`, error);
    if (!res.headersSent) {
      return res.status(500).send('Internal server error');
    }
    next(error);
  }
});

export default router;
