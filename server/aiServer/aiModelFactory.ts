import { EmbeddingProvider, AiUtilities } from './providers';
import { LibSQLVector } from '@mastra/libsql';
import { EmbeddingModelV1 } from '@ai-sdk/provider';
import { embed } from 'ai';
import { _ } from '@shared/lib/lodash';
import { prisma } from '@server/prisma';
import { getGlobalConfig } from '@server/routerTrpc/config';

export class AiModelFactory {
  static async queryAndDeleteVectorById(targetId: number) {
    const { VectorStore } = await AiModelFactory.GetProvider();
    try {
      const query = `
          DELETE FROM 'blinkora'
          WHERE metadata->>'id' = ? OR metadata->>'noteId' = ?
          RETURNING *;`;
      //@ts-ignore libsql vector exposes turso internally
      const result = await VectorStore.turso.execute({
        sql: query,
        args: [targetId, targetId],
      });

      return {
        success: true,
        deletedCount: result.rows.length,
        deletedData: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  static async queryVector(query: string, accountId: number, _topK?: number) {
    const { VectorStore, Embeddings } = await AiModelFactory.GetProvider();
    if (!Embeddings) {
      throw new Error('No embeddings model config');
    }

    const config = await AiModelFactory.globalConfig();
    const topK = _topK ?? config.embeddingTopK ?? 3;
    const embeddingMinScore = config.embeddingScore ?? 0.4;
    const { embedding } = await embed({
      value: query,
      model: Embeddings,
    });

    const result = await VectorStore.query({
      indexName: 'blinkora',
      queryVector: embedding,
      topK,
    });
    const filteredResults = result.filter(({ score }) => score >= embeddingMinScore);
    const noteIds = _.uniqWith(filteredResults.map((item) => Number(item.metadata?.id ?? item.metadata?.noteId))).filter(Boolean) as number[];

    const notes = (
      await prisma.notes.findMany({
        where: {
          accountId,
          id: { in: noteIds },
          isRecycle: false,
        },
        include: {
          tags: { include: { tag: true } },
          attachments: {
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
          references: {
            select: {
              toNoteId: true,
              toNote: {
                select: {
                  content: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
            },
          },
          referencedBy: {
            select: {
              fromNoteId: true,
              fromNote: {
                select: {
                  content: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
            },
          },
          _count: {
            select: {
              histories: true,
            },
          },
        },
      })
    ).map((note) => ({
      ...note,
      score: filteredResults.find((item) => Number(item.metadata?.id ?? item.metadata?.noteId) === note.id)?.score ?? 0,
    }));

    const aiContext = notes.map((note) => `${note.content}\n`).join('');
    return { notes, aiContext };
  }

  static async rebuildVectorIndex({ vectorStore, isDelete = false }: { vectorStore: LibSQLVector; isDelete?: boolean }) {
    try {
      if (isDelete) {
        await vectorStore.deleteIndex({ indexName: 'blinkora' });
      }
    } catch (error) {
      console.error('delete vector index failed:', error);
    }

    const config = await AiModelFactory.globalConfig();
    const embeddingModel = config.embeddingModelId ? await AiModelFactory.getAiModel(config.embeddingModelId) : null;
    if (!embeddingModel) {
      console.warn('Embedding model not configured, skipping vector index creation');
      return;
    }

    const model = embeddingModel.modelKey.toLowerCase();
    const userConfigDimensions = (embeddingModel.config as any)?.embeddingDimensions || config.embeddingDimensions || 0;
    let dimensions = 0;
    switch (true) {
      case model.includes('text-embedding-3-small'):
        dimensions = 1536;
        break;
      case model.includes('text-embedding-3-large'):
        dimensions = 3072;
        break;
      case model.includes('cohere/embed-english-v3') || model.includes('bge-m3') || model.includes('voyage') || model.includes('bge-large'):
        dimensions = 1024;
        break;
      case model.includes('cohere'):
        dimensions = 4096;
        break;
      case model.includes('voyage-3-lite'):
        dimensions = 512;
        break;
      case model.includes('bge') || model.includes('bert') || model.includes('bce-embedding-base'):
        dimensions = 768;
        break;
      case model.includes('all-minilm'):
        dimensions = 384;
        break;
      case model.includes('mxbai-embed-large'):
        dimensions = 1024;
        break;
      case model.includes('nomic-embed-text'):
        dimensions = 768;
        break;
      case model.includes('bge-large-en'):
        dimensions = 1024;
        break;
      default:
        if (!userConfigDimensions) {
          throw new Error('Must set the embedding dimension in search index settings');
        }
    }

    if (userConfigDimensions) {
      dimensions = userConfigDimensions;
    }
    await vectorStore.createIndex({ indexName: 'blinkora', dimension: dimensions, metric: 'cosine' });
  }

  static async globalConfig() {
    return await getGlobalConfig({ useAdmin: true });
  }

  static async getAiProvider(id: number) {
    return await prisma.aiProviders.findUnique({
      where: { id },
      include: { models: true },
    });
  }

  static async getAllAiProviders() {
    return await prisma.aiProviders.findMany({
      include: { models: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  static async getAiModel(id: number) {
    return await prisma.aiModels.findUnique({
      where: { id },
      include: { provider: true },
    });
  }

  static async getAiModelsByCapability(capability: string) {
    return await prisma.aiModels.findMany({
      where: {
        capabilities: {
          path: [capability],
          equals: true,
        },
      },
      include: { provider: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  static async ValidConfig() {
    return await AiModelFactory.globalConfig();
  }

  static async GetProvider() {
    const globalConfig = await AiModelFactory.ValidConfig();
    const embeddingProvider = new EmbeddingProvider();

    let embeddings: EmbeddingModelV1<string> | null = null;
    if (globalConfig.embeddingModelId) {
      const embeddingModel = await AiModelFactory.getAiModel(globalConfig.embeddingModelId);
      if (embeddingModel) {
        embeddings = await embeddingProvider.getEmbeddingModel({
          provider: embeddingModel.provider.provider,
          apiKey: embeddingModel.provider.apiKey,
          baseURL: embeddingModel.provider.baseURL,
          modelKey: embeddingModel.modelKey,
          apiVersion: (embeddingModel.provider.config as any)?.apiVersion,
        });
      }
    }

    const vectorStore = await AiUtilities.VectorStore();
    return {
      LLM: null,
      VectorStore: vectorStore,
      Embeddings: embeddings,
      MarkdownSplitter: AiUtilities.MarkdownSplitter(),
      TokenTextSplitter: AiUtilities.TokenTextSplitter(),
      provider: {
        embeddingProvider,
      },
    };
  }

}
