'use strict';
// Definitions for the RET-008 retrieval-load comparison.
//
// Pure definitions only: a fixed small corpus, fixed semantic queries and
// the human-labelled relevant documents for each query. Nothing here talks to
// a model, a vector store or the network, so the same file backs both the
// explicit probe (real embedding model) and the offline regression (stub
// embedder, contract only).
//
// The corpus is written in Chinese on purpose: the offline model that the
// product actually uses for this lane is Xenova/bge-small-zh-v1.5, a Chinese
// model, and the semantic questions are phrased the way a user would ask
// them rather than by copying sentences out of the documents.
//
// Ground truth is human-labelled: `relevant` lists the documents that really
// answer the question. A document that merely shares a word with the
// question is deliberately NOT in the list.
const fs = require('node:fs');
const path = require('node:path');

// Fixed corpus: id -> { file, content }. The file name is the join key used
// to map a search result back to a corpus id.
const CORPUS = [
  {
    id: 'quota-sampling',
    file: 'quota-sampling.md',
    content: [
      '# 配额采样',
      '',
      '配额采样必须串行执行。同一个订阅的并发采样请求会互相抢占剩余额度，',
      '导致返回的可用额度不准确。串行执行让每一轮采样都拿到稳定的结果。',
      '采样脚本在每轮结束后等待一个退避间隔，再开始下一轮。',
    ].join('\n'),
  },
  {
    id: 'index-rebuild',
    file: 'index-rebuild.md',
    content: [
      '# 向量索引重建',
      '',
      '切换索引根目录之后必须重建向量索引，否则检索会继续命中旧目录里的文档。',
      '重建过程使用与在线检索完全相同的嵌入模型和向量维度，',
      '保证重建前后的相似度分数可以直接比较。',
      '重建是幂等操作，内容没有变化的文档会被哈希检查跳过。',
    ].join('\n'),
  },
  {
    id: 'hook-install',
    file: 'hook-install.md',
    content: [
      '# 提交钩子安装',
      '',
      '安装钩子会在目标仓库的 Git 钩子目录写入一个受管理的 post-commit 脚本。',
      '脚本带有可识别的标记行，升级时会覆盖旧版本而不是追加。',
      '提交完成后钩子会把提交边界事件追加到事件桥接的日志里。',
    ].join('\n'),
  },
  {
    id: 'bridge-journal',
    file: 'bridge-journal.md',
    content: [
      '# 事件桥接日志',
      '',
      '事件桥接把提交边界写成追加式的日志事件，每个事件带有单调递增的序号。',
      '消费端按照序号游标读取事件，因此重复消费不会产生重复的副作用。',
      '桥接服务是一个独立进程，钩子通过 HTTP 把事件投递给它。',
    ].join('\n'),
  },
  {
    id: 'promotion-rule',
    file: 'promotion-rule.md',
    content: [
      '# 知识晋升规则',
      '',
      '一次提交经过分析之后，只有满足校验清单的结果才能晋升为知识文档。',
      '校验清单要求结果里同时出现提交哈希、补丁哈希、会话哈希和检索哈希的引用。',
      '缺少任何一项引用都会被拒绝，晋升失败不会写入知识目录。',
    ].join('\n'),
  },
  {
    id: 'retrieval-citation',
    file: 'retrieval-citation.md',
    content: [
      '# 检索引用与提交',
      '',
      '检索命中的知识条目会带上产生它的那次提交的完整哈希。',
      '引用里的哈希指向知识文档本身，而不是某个临时目录中的文件名。',
      '只有正文和引用同时命中时，这条知识才算是被检索链路真正采用了。',
    ].join('\n'),
  },
  {
    id: 'embed-model',
    file: 'embed-model.md',
    content: [
      '# 本地嵌入模型',
      '',
      '本地嵌入模型是一个中文向量模型，输出的向量维度是 512。',
      '模型权重缓存在离线目录里，运行时不会联网下载。',
      '建立索引用段落嵌入，查询用查询嵌入，两者的向量维度必须一致。',
    ].join('\n'),
  },
  {
    id: 'session-memory',
    file: 'session-memory.md',
    content: [
      '# 会话记忆',
      '',
      '会话记忆按会话编号保存在独立的数据目录下，每个会话一个文件。',
      '记忆文件里记录的是上一轮对话的结论，而不是原始的提问。',
      '删除记忆只会清理这个数据目录，不会影响知识库里的内容。',
    ].join('\n'),
  },
  {
    id: 'profile-credential',
    file: 'profile-credential.md',
    content: [
      '# 订阅凭据',
      '',
      '订阅密钥保存在本机的凭据文件里，配置文件只保存对凭据的引用名称。',
      '读取订阅时密钥只在内存里存在，不会被打印或者写进日志。',
      '切换订阅不会触发任何额度查询，额度状态不参与调度判断。',
    ].join('\n'),
  },
  {
    id: 'isolated-port',
    file: 'isolated-port.md',
    content: [
      '# 端口隔离',
      '',
      '测试期间所有的服务都绑定在独立的临时端口上，避免碰到正在运行的实例。',
      '通知请求会被引导到一个隔离的接收端，真实的站点端口不会被访问。',
      '每个用例使用独立的数据目录和独立的用户主目录。',
    ].join('\n'),
  },
  {
    id: 'ledger-binding',
    file: 'ledger-binding.md',
    content: [
      '# 用例绑定表',
      '',
      '绑定表把每个用例映射到它所验证的模块和接口。',
      '绑定表是共享的资产，单条用例只允许提供自己的定义片段。',
      '绑定片段必须是纯定义，不能包含执行逻辑。',
    ].join('\n'),
  },
  {
    id: 'archive-policy',
    file: 'archive-policy.md',
    content: [
      '# 归档策略',
      '',
      '归档只针对明确标记为归档的会话，普通会话永远不会被自动归档或者删除。',
      '归档之后仍然保留原始文件，只是从活跃列表里移走。',
      '恢复归档会把会话放回活跃列表，并保留原来的会话编号。',
    ].join('\n'),
  },
];

// Fixed semantic queries with human-labelled relevant documents.
const QUERIES = [
  {
    id: 'q-quota-serial',
    query: '为什么额度采样不能并发执行',
    relevant: ['quota-sampling'],
    note: '直接问配额采样的执行方式',
  },
  {
    id: 'q-index-rebuild',
    query: '换了索引目录以后向量索引要做什么',
    relevant: ['index-rebuild'],
    note: '问切换索引根之后必须做的事',
  },
  {
    id: 'q-hook-trigger',
    query: '提交代码之后是谁把变更交给分析流程',
    relevant: ['hook-install', 'bridge-journal'],
    note: '钩子与桥接两篇都参与这条链路',
  },
  {
    id: 'q-promotion-accept',
    query: '分析结果要满足什么条件才能写进知识库',
    relevant: ['promotion-rule'],
    note: '问晋升的校验条件',
  },
  {
    id: 'q-citation-sha',
    query: '检索出来的知识怎么追溯到是哪次提交写的',
    relevant: ['retrieval-citation'],
    note: '问引用与提交的关系',
  },
  {
    id: 'q-model-cache',
    query: '离线的中文向量模型放在什么地方 维度是多少',
    relevant: ['embed-model'],
    note: '问模型缓存位置与维度',
  },
  {
    id: 'q-memory-dir',
    query: '上一轮对话的结论存在哪个目录里',
    relevant: ['session-memory'],
    note: '问会话记忆的存储位置',
  },
  {
    id: 'q-credential-secret',
    query: '订阅密钥是从哪个文件读出来的',
    relevant: ['profile-credential'],
    note: '问凭据来源，注意 archive-policy 里有"文件"但不相关',
  },
  {
    id: 'q-port-isolation',
    query: '测试的时候怎么保证不碰到正在跑的那个服务',
    relevant: ['isolated-port'],
    note: '问测试期的端口隔离',
  },
  {
    id: 'q-binding-fragment',
    query: '一条用例怎么声明自己验证了哪个模块',
    relevant: ['ledger-binding'],
    note: '问绑定片段的产出方式',
  },
];

// Materialises the corpus into `targetDir` (flat, one file per document) and
// returns the mapping used to translate a search result back to a corpus id.
function materialiseCorpus(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const byFile = new Map();
  for (const doc of CORPUS) {
    fs.writeFileSync(path.join(targetDir, doc.file), doc.content, 'utf8');
    byFile.set(doc.file, doc.id);
  }
  return {
    dir: targetDir,
    fileCount: CORPUS.length,
    byFile,
    idForFile(file) {
      const base = path.basename(String(file || ''));
      return byFile.get(base) || null;
    },
  };
}

// Ranking metrics over the fixed ground truth.
// - recallAt1 / recallAt5: share of relevant documents found in the top-k.
// - mrr: mean reciprocal rank of the first relevant document.
// - retrievedDocIds: the ordered, de-duplicated document ids of one query.
function evaluateRanking(rankedDocIds, relevant) {
  const relevantSet = new Set(relevant);
  const hits = [];
  for (let index = 0; index < rankedDocIds.length; index += 1) {
    if (relevantSet.has(rankedDocIds[index])) hits.push(index + 1);
  }
  const firstHit = hits.length ? hits[0] : null;
  const inTop = count => hits.filter(rank => rank <= count).length;
  return {
    relevant: [...relevant],
    retrievedDocIds: [...rankedDocIds],
    firstRelevantRank: firstHit,
    reciprocalRank: firstHit ? 1 / firstHit : 0,
    hits,
    recallAt1: relevant.length ? inTop(1) / relevant.length : 0,
    recallAt5: relevant.length ? inTop(5) / relevant.length : 0,
    hit: hits.length > 0,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[position];
}

function summariseLatency(values) {
  const finite = values.filter(value => Number.isFinite(value));
  return {
    count: finite.length,
    min: finite.length ? Math.min(...finite) : null,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length ? Math.max(...finite) : null,
    mean: finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null,
  };
}

module.exports = {
  CORPUS,
  QUERIES,
  materialiseCorpus,
  evaluateRanking,
  summariseLatency,
  percentile,
};
