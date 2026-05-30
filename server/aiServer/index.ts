import { prisma } from '../prisma';
import { AiModelFactory } from './aiModelFactory';
import { ProgressResult } from '@shared/lib/types';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { UnstructuredLoader } from '@langchain/community/document_loaders/fs/unstructured';
import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';
import { FileService } from '../lib/files';
import { Context } from '../context';
import { MDocument } from '@mastra/rag';
import { embedMany } from 'ai';
import { RebuildEmbeddingJob } from '../jobs/rebuildEmbeddingJob';
import { LibSQLVector } from '@mastra/libsql';

export function isImage(filePath: string): boolean {
  if (!filePath) return false;
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
  return imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext));
}

export function isAudio(filePath: string): boolean {
  if (!filePath) return false;
  const audioExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus', '.webm'];
  return audioExtensions.some((ext) => filePath.toLowerCase().endsWith(ext));
}

export class AiService {
  static isImage = isImage;
  static isAudio = isAudio;

  static async loadFileContent(filePath: string): Promise<string> {
    let loader: BaseDocumentLoader;
    switch (true) {
      case filePath.endsWith('.pdf'):
        loader = new PDFLoader(filePath);
        break;
      case filePath.endsWith('.docx') || filePath.endsWith('.doc'):
        loader = new DocxLoader(filePath);
        break;
      case filePath.endsWith('.txt'):
        loader = new TextLoader(filePath);
        break;
      case filePath.endsWith('.csv'):
        loader = new CSVLoader(filePath);
        break;
      default:
        loader = new UnstructuredLoader(filePath);
    }

    const docs = await loader.load();
    return docs.map((doc) => doc.pageContent).join('\n');
  }

  static async embeddingDeleteAll(_id: number, VectorStore: LibSQLVector) {
    await VectorStore.truncateIndex({ indexName: 'blinkora' });
  }

  static async embeddingDeleteAllAttachments(_filePath: string, VectorStore: LibSQLVector) {
    await VectorStore.truncateIndex({ indexName: 'blinkora' });
  }

  static async embeddingUpsert({ id, content, type, createTime, updatedAt }: { id: number; content: string; type: 'update' | 'insert'; createTime: Date; updatedAt?: Date }) {
    try {
      const { VectorStore, Embeddings } = await AiModelFactory.GetProvider();
      if (!Embeddings) throw new Error('No embeddings model config');

      const config = await AiModelFactory.globalConfig();
      if (config.excludeEmbeddingTagId) {
        const tag = await prisma.tag.findUnique({ where: { id: config.excludeEmbeddingTagId } });
        if (tag && content.includes(tag.name)) {
          return { ok: false, msg: 'tag is not allowed to be embedded' };
        }
      }

      const note = await prisma.notes.findUnique({ where: { id }, select: { metadata: true } });
      const chunks = await MDocument.fromMarkdown(content).chunk();
      if (type === 'update') {
        await AiModelFactory.queryAndDeleteVectorById(id);
      }

      const { embeddings } = await embedMany({
        values: chunks.map((chunk) => `${chunk.text}\nCreate At: ${createTime.toISOString()} Update At: ${updatedAt?.toISOString()}`),
        model: Embeddings,
      });

      await VectorStore.upsert({
        indexName: 'blinkora',
        vectors: embeddings,
        metadata: chunks.map((chunk) => ({ text: chunk.text, id, noteId: id, createTime, updatedAt })),
      });

      await prisma.notes.update({
        where: { id },
        data: {
          metadata: { ...((note?.metadata as object) || {}), isIndexed: true },
          updatedAt,
        },
      });

      return { ok: true };
    } catch (error) {
      console.log(error, 'embeddingUpsert error');
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  static async embeddingInsertAttachments({ id, updatedAt, filePath }: { id: number; updatedAt?: Date; filePath: string }) {
    try {
      const fileResult = await FileService.getFile(filePath);
      let content: string;
      try {
        if (AiService.isImage(filePath) || AiService.isAudio(filePath)) {
          return { ok: false, error: 'image and audio attachments are not indexed in the simplified base' };
        }
        content = await AiService.loadFileContent(fileResult.path);
      } finally {
        if (fileResult.isTemporary && fileResult.cleanup) {
          await fileResult.cleanup();
        }
      }

      const { VectorStore, Embeddings } = await AiModelFactory.GetProvider();
      if (!Embeddings) throw new Error('No embeddings model config');

      const chunks = await MDocument.fromText(content).chunk();
      const { embeddings } = await embedMany({
        values: chunks.map((chunk) => `${chunk.text}\nUpdate At: ${updatedAt?.toISOString()}`),
        model: Embeddings,
      });

      await VectorStore.upsert({
        indexName: 'blinkora',
        vectors: embeddings,
        metadata: chunks.map((chunk) => ({ text: chunk.text, id, noteId: id, isAttachment: true, updatedAt })),
      });

      const note = await prisma.notes.findUnique({ where: { id }, select: { metadata: true } });
      await prisma.notes.update({
        where: { id },
        data: {
          metadata: { ...((note?.metadata as object) || {}), isIndexed: true, isAttachmentsIndexed: true },
          updatedAt,
        },
      });

      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  static async embeddingDelete({ id }: { id: number }) {
    await AiModelFactory.queryAndDeleteVectorById(id);
    return { ok: true };
  }

  static async *rebuildEmbeddingIndex({ force = false }: { force?: boolean }): AsyncGenerator<ProgressResult & { progress?: { current: number; total: number } }, void, unknown> {
    yield {
      type: 'info' as const,
      content: 'Rebuild embedding index task started - check task progress for details',
      progress: { current: 0, total: 0 },
    };
    await RebuildEmbeddingJob.ForceRebuild(force);
  }

  static async enhanceQuery({ query, ctx }: { query: string; ctx: Context }) {
    try {
      const { notes } = await AiModelFactory.queryVector(query, Number(ctx.id));
      return notes;
    } catch (error) {
      console.error('Error in enhanceQuery:', error);
      return [];
    }
  }
}
