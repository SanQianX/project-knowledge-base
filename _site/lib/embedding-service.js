const path = require('path');
const { EMBEDDING_DIMENSIONS } = require('./knowledge-schema');

const DEFAULT_MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

class LocalEmbeddingService {
  constructor(options = {}) {
    this.modelId = options.modelId || DEFAULT_MODEL_ID;
    this.cacheDir = options.cacheDir ? path.resolve(options.cacheDir) : null;
    this.localFilesOnly = options.localFilesOnly === true;
    this.pipelineFactory = options.pipelineFactory || null;
    this.extractor = null;
    this.loading = null;
  }

  async load() {
    if (this.extractor) return this.extractor;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let pipelineFactory = this.pipelineFactory;
      if (!pipelineFactory) {
        const transformers = await import('@huggingface/transformers');
        if (this.cacheDir) transformers.env.cacheDir = this.cacheDir;
        transformers.env.allowRemoteModels = !this.localFilesOnly;
        pipelineFactory = transformers.pipeline;
      }
      const extractor = await pipelineFactory('feature-extraction', this.modelId, {
        dtype: 'fp32',
        local_files_only: this.localFilesOnly,
      });
      this.extractor = extractor;
      return extractor;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async embed(text, options = {}) {
    const normalized = String(text || '').trim();
    if (!normalized) throw new Error('text is required for embedding');
    const extractor = await this.load();
    const input = options.kind === 'query' ? `${QUERY_PREFIX}${normalized}` : normalized;
    const output = await extractor(input, { pooling: 'cls', normalize: true });
    const vector = Array.from(output.data || output.tolist?.()[0] || [], Number);
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding model returned ${vector.length} dimensions; expected ${EMBEDDING_DIMENSIONS}`);
    }
    return vector;
  }

  embedQuery(text) {
    return this.embed(text, { kind: 'query' });
  }

  embedPassage(text) {
    return this.embed(text, { kind: 'passage' });
  }

  status() {
    return {
      modelId: this.modelId,
      dimensions: EMBEDDING_DIMENSIONS,
      cacheDir: this.cacheDir,
      loaded: !!this.extractor,
      localFilesOnly: this.localFilesOnly,
    };
  }
}

module.exports = { LocalEmbeddingService, DEFAULT_MODEL_ID, QUERY_PREFIX };
