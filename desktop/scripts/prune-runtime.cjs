const fs = require('fs');
const path = require('path');

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to prune path outside packaged app: ${target}`);
  }
}

function remove(root, target) {
  ensureInside(root, target);
  fs.rmSync(target, { recursive: true, force: true });
}

function removeDirectoryChildrenExcept(root, directory, allowed) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory)) {
    if (!allowed.has(entry)) remove(root, path.join(directory, entry));
  }
}

function removeFilesMatching(root, directory, predicate) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) removeFilesMatching(root, target, predicate);
    else if (predicate(target)) remove(root, target);
  }
}

function pruneWindowsRuntime(buildPath, { platform, arch }) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`desktop runtime pruning supports win32-x64 only, received ${platform}-${arch}`);
  }

  const root = path.resolve(buildPath);
  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(modules)) throw new Error(`packaged node_modules not found: ${modules}`);

  // Claude Agent SDK remains as the small JS control layer, but Claude Code
  // itself must come from the user's PATH / CLAUDE_CODE_EXECPATH.
  const anthropicRoot = path.join(modules, '@anthropic-ai');
  if (fs.existsSync(anthropicRoot)) {
    for (const entry of fs.readdirSync(anthropicRoot)) {
      if (/^claude-agent-sdk-(?:darwin|linux|win32)-/.test(entry)) {
        remove(root, path.join(anthropicRoot, entry));
      }
    }
  }

  // LanceDB's embedding providers are optional. The application owns the one
  // Transformers.js embedding service it uses, so nested providers are waste.
  const lanceNested = path.join(modules, '@lancedb', 'lancedb', 'node_modules');
  remove(root, path.join(lanceNested, '@huggingface'));
  remove(root, path.join(lanceNested, '@img'));
  for (const name of ['onnxruntime-node', 'onnxruntime-web', 'onnxruntime-common', 'sharp', 'openai']) {
    remove(root, path.join(lanceNested, name));
  }

  // onnxruntime-node publishes every supported OS/CPU in one package. Keep
  // only the Windows x64 native binding and its runtime DLLs.
  const napiRoot = path.join(modules, 'onnxruntime-node', 'bin', 'napi-v3');
  removeDirectoryChildrenExcept(root, napiRoot, new Set(['win32']));
  removeDirectoryChildrenExcept(root, path.join(napiRoot, 'win32'), new Set(['x64']));

  // Transformers imports onnxruntime-web even under Node. Keep its tiny Node
  // bridge, but remove browser bundles, WASM/WebGPU runtimes and source maps.
  const ortWeb = path.join(modules, 'onnxruntime-web');
  remove(root, path.join(ortWeb, 'lib'));
  remove(root, path.join(ortWeb, 'types'));
  removeDirectoryChildrenExcept(
    root,
    path.join(ortWeb, 'dist'),
    new Set(['ort.node.min.js', 'ort.node.min.mjs'])
  );

  // Only the Node CommonJS/ESM builds are reachable from this application.
  const transformers = path.join(modules, '@huggingface', 'transformers');
  remove(root, path.join(transformers, 'src'));
  removeDirectoryChildrenExcept(
    root,
    path.join(transformers, 'dist'),
    new Set(['transformers.node.cjs', 'transformers.node.mjs'])
  );

  for (const packageRoot of [
    path.join(modules, 'onnxruntime-node'),
    ortWeb,
    transformers,
  ]) {
    removeFilesMatching(root, packageRoot, file => /\.(?:map|ts)$/i.test(file));
  }
}

module.exports = { pruneWindowsRuntime };
