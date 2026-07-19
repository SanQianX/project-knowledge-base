const assert = require('assert');
const { selectedDirectoryFromOutput } = require('../lib/folder-picker-output');

const banner = '������µĿ�ƽ̨ PowerShell https://aka.ms/pscore6';
assert.equal(selectedDirectoryFromOutput(banner, { exists: () => false }), '',
  'PowerShell banner text must never be accepted as a selected folder');

const folder = 'D:\\work\\project';
assert.equal(selectedDirectoryFromOutput(`${banner}\r\n${folder}\r\n`, {
  exists: candidate => candidate === folder,
  stat: () => ({ isDirectory: () => true }),
}), folder, 'the existing absolute directory should be selected from mixed output');

assert.equal(selectedDirectoryFromOutput('relative-folder', {
  exists: () => true,
  stat: () => ({ isDirectory: () => true }),
}), '', 'relative output must not be accepted');

console.log('folder-picker-output-test PASS');
