'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {productFiles}=require('../scripts/pack-module-candidates');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kb-candidate-assets-'));
try{
  const files=['ui/index.html','ui/knowledge-panel.html','ui/product.js','ui/live-client.js','ui/product.css','ui/favicon.svg','plugins/project-knowledge/scripts/context-hook.cjs'];
  for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),file+' changed');}
  fs.writeFileSync(path.join(root,'module-runtime-manifest.json'),JSON.stringify({productFiles:{[files.at(-1)]:'old-hash'}}));
  const result=productFiles(root);
  assert.equal(Object.keys(result).length,7);
  assert.equal(result[files.at(-1)],crypto.createHash('sha256').update(files.at(-1)+' changed').digest('hex'));
  console.log('candidate-product-assets-test PASS');
}finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
