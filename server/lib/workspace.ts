import { prisma } from "../prisma";

type WorkspaceHeader = string | string[] | number | undefined | null;

const normalizeWorkspaceHeader = (workspaceHeader?: WorkspaceHeader) => {
  if (Array.isArray(workspaceHeader)) return workspaceHeader[0];
  if (workspaceHeader === undefined || workspaceHeader === null) return undefined;
  return String(workspaceHeader);
};

export async function resolveWorkspaceIdForAccount(accountId: number, workspaceHeader?: WorkspaceHeader) {
  const workspaceHeaderValue = normalizeWorkspaceHeader(workspaceHeader);
  let workspaceId: number | undefined;

  if (workspaceHeaderValue) {
    const ws = await prisma.workspaces.findFirst({
      where: { id: Number(workspaceHeaderValue), accountId },
    });
    if (ws) {
      workspaceId = ws.id;
    }
  }

  if (!workspaceId) {
    const defaultWs = await prisma.workspaces.findFirst({
      where: { accountId, isDefault: true },
    });
    if (defaultWs) {
      workspaceId = defaultWs.id;
    }
  }

  if (!workspaceId) {
    const newWs = await prisma.workspaces.create({
      data: {
        name: "默认工作区",
        accountId,
        isDefault: true,
      },
    });
    workspaceId = newWs.id;

    await prisma.notes.updateMany({
      where: { accountId, workspaceId: null },
      data: { workspaceId },
    });
    await prisma.tag.updateMany({
      where: { accountId, workspaceId: null },
      data: { workspaceId },
    });
    await prisma.attachments.updateMany({
      where: { accountId, workspaceId: null },
      data: { workspaceId },
    });
    await prisma.comments.updateMany({
      where: { accountId, workspaceId: null },
      data: { workspaceId },
    });
    await prisma.config.updateMany({
      where: { userId: accountId, workspaceId: null },
      data: { workspaceId },
    });
    await prisma.noteHistory.updateMany({
      where: { accountId, workspaceId: null },
      data: { workspaceId },
    });
  }

  return workspaceId;
}
