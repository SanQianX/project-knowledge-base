'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {productFiles}=require('../src/scripts/pack-module-candidates');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kb-candidate-assets-'));
try{
  const files=['resources/ui/index.html','resources/ui/knowledge-panel.html','resources/ui/product.js','resources/ui/live-client.js','resources/ui/product.css','resources/ui/favicon.svg','plugins/project-knowledge/scripts/context-hook.cjs'];
  for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),file+' changed');}
  fs.writeFileSync(path.join(root,'module-runtime-manifest.json'),JSON.stringify({productFiles:{[files.at(-1)]:'old-hash'}}));
  const result=productFiles(root);
  assert.equal(Object.keys(result).length,7);
  assert.equal(result[files.at(-1)],crypto.createHash('sha256').update(files.at(-1)+' changed').digest('hex'));
  console.log('candidate-product-assets-test PASS');
}finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
