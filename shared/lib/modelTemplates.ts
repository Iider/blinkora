export interface ModelCapabilities {
  embedding: boolean;
  rerank: boolean;
}

export interface ModelTemplate {
  modelKey: string;
  title: string;
  capabilities: Partial<ModelCapabilities>;
  config?: {
    embeddingDimensions?: number;
  };
}

export const DEFAULT_MODEL_TEMPLATES: ModelTemplate[] = [
  { modelKey: 'text-embedding-3-large', title: 'Text Embedding 3 Large', capabilities: { embedding: true }, config: { embeddingDimensions: 3072 } },
  { modelKey: 'text-embedding-3-small', title: 'Text Embedding 3 Small', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'text-embedding-ada-002', title: 'Text Embedding Ada 002', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'text-embedding-004', title: 'Text Embedding 004', capabilities: { embedding: true }, config: { embeddingDimensions: 768 } },
  { modelKey: 'text-embedding-gecko', title: 'Text Embedding Gecko', capabilities: { embedding: true }, config: { embeddingDimensions: 768 } },
  { modelKey: 'embed-english-v3.0', title: 'Embed English v3.0', capabilities: { embedding: true } },
  { modelKey: 'embed-multilingual-v3.0', title: 'Embed Multilingual v3.0', capabilities: { embedding: true } },
  { modelKey: 'nomic-embed-text', title: 'Nomic Embed Text (Ollama)', capabilities: { embedding: true }, config: { embeddingDimensions: 768 } },
  { modelKey: 'mxbai-embed-large', title: 'MxBai Embed Large (Ollama)', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'all-minilm:l6-v2', title: 'All MiniLM L6 v2 (Ollama)', capabilities: { embedding: true }, config: { embeddingDimensions: 384 } },
  { modelKey: 'voyage-3', title: 'Voyage 3', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-3-lite', title: 'Voyage 3 Lite', capabilities: { embedding: true }, config: { embeddingDimensions: 512 } },
  { modelKey: 'voyage-large-2-instruct', title: 'Voyage Large 2 Instruct', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'voyage-law-2', title: 'Voyage Law 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-code-2', title: 'Voyage Code 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'voyage-large-2', title: 'Voyage Large 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'voyage-2', title: 'Voyage 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-lite-02-instruct', title: 'Voyage Lite 02 Instruct', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-multilingual-2', title: 'Voyage Multilingual 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-finance-2', title: 'Voyage Finance 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'rerank-english-v3.0', title: 'Rerank English v3.0', capabilities: { rerank: true } },
  { modelKey: 'rerank-multilingual-v3.0', title: 'Rerank Multilingual v3.0', capabilities: { rerank: true } },
  { modelKey: 'rerank-2', title: 'Rerank 2', capabilities: { rerank: true } },
  { modelKey: 'rerank-lite-1', title: 'Rerank Lite 1', capabilities: { rerank: true } }
];

export function inferModelCapabilities(modelName: string): ModelCapabilities {
  const name = modelName.toLowerCase();
  const template = DEFAULT_MODEL_TEMPLATES.find(t =>
    name.includes(t.modelKey.toLowerCase()) ||
    t.modelKey.toLowerCase().includes(name)
  );

  if (!template) {
    return {
      embedding: /embed|embedding/.test(name),
      rerank: /rerank/.test(name)
    };
  }

  return {
    embedding: template.capabilities.embedding || false,
    rerank: template.capabilities.rerank || false
  };
}
