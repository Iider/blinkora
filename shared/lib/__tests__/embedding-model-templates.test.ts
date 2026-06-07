import { describe, expect, it } from 'bun:test';
import { DEFAULT_MODEL_TEMPLATES, inferModelCapabilities } from '../modelTemplates';

describe('Embedding model templates', () => {
  it('keeps default templates scoped to RAG-related capabilities', () => {
    expect(DEFAULT_MODEL_TEMPLATES.length).toBeGreaterThan(5);

    for (const model of DEFAULT_MODEL_TEMPLATES) {
      expect(model.modelKey).toBeTruthy();
      expect(model.title).toBeTruthy();
      expect(model.capabilities.embedding || model.capabilities.rerank).toBe(true);
      expect(Object.keys(model.capabilities).sort()).toEqual(
        Object.keys(model.capabilities).filter(key => key === 'embedding' || key === 'rerank').sort()
      );
    }
  });

  it('includes common embedding models with dimensions', () => {
    const large = DEFAULT_MODEL_TEMPLATES.find(model => model.modelKey === 'text-embedding-3-large');
    const small = DEFAULT_MODEL_TEMPLATES.find(model => model.modelKey === 'text-embedding-3-small');

    expect(large?.capabilities.embedding).toBe(true);
    expect(large?.config?.embeddingDimensions).toBe(3072);
    expect(small?.capabilities.embedding).toBe(true);
    expect(small?.config?.embeddingDimensions).toBe(1536);
  });

  it('infers embedding and rerank capabilities from known and custom names', () => {
    expect(inferModelCapabilities('text-embedding-3-small')).toEqual({ embedding: true, rerank: false });
    expect(inferModelCapabilities('rerank-english-v3.0')).toEqual({ embedding: false, rerank: true });
    expect(inferModelCapabilities('custom-embedding-model')).toEqual({ embedding: true, rerank: false });
    expect(inferModelCapabilities('custom-rerank-model')).toEqual({ embedding: false, rerank: true });
    expect(inferModelCapabilities('chat-model')).toEqual({ embedding: false, rerank: false });
  });

  it('does not include chat model templates', () => {
    const keys = DEFAULT_MODEL_TEMPLATES.map(model => model.modelKey.toLowerCase());

    expect(keys.some(key => key.includes('gpt-4o'))).toBe(false);
    expect(keys.some(key => key.includes('sonnet'))).toBe(false);
    expect(keys.some(key => key.includes('minimax'))).toBe(false);
  });
});
