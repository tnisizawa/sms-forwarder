'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const exists = name => fs.existsSync(path.join(root, name));
const markdownFiles = () => [path.join(root, 'README.md'),
  ...fs.readdirSync(path.join(root, 'docs'), { recursive: true })
    .filter(name => name.endsWith('.md')).map(name => path.join(root, 'docs', name))];

test('recipient docs exist and absorbed originals are moved or removed', () => {
  for (const name of ['docs/setup.md', 'docs/updating.md', 'docs/development.md', 'docs/troubleshooting.md', 'CHANGELOG.md', 'docs/legacy/macrodroid.md']) {
    assert.equal(exists(name), true, name + ' missing');
  }
  assert.equal(exists('docs/smsforwarder.md'), false);
  assert.equal(exists('docs/macrodroid.md'), false);
});

test('every relative markdown and image link resolves to a real file', () => {
  const broken = [];
  for (const file of markdownFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(https?|mailto):/.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
        broken.push(path.relative(root, file) + ' -> ' + match[1]);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('every image in docs/images is referenced and every referenced image exists', () => {
  const dir = path.join(root, 'docs', 'images');
  const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const referenced = new Set();
  for (const file of markdownFiles()) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]*images\/[^)\s]+)\)/g)) {
      referenced.add(path.basename(match[1]));
    }
  }
  assert.equal(onDisk.length > 0, true, 'docs/images is empty');
  for (const name of onDisk) assert.equal(referenced.has(name), true, 'unreferenced image: ' + name);
  for (const name of referenced) assert.equal(onDisk.includes(name), true, 'missing image: ' + name);
});

test('CHANGELOG documents the version declared in lib.js', () => {
  const match = read('gas/lib.js').match(/var VERSION = '([^']+)'/);
  assert.ok(match, 'VERSION declaration not found in gas/lib.js');
  assert.equal(read('CHANGELOG.md').includes('## ' + match[1]), true);
});

test('the troubleshooting table lives in exactly one document', () => {
  const hits = markdownFiles().filter(file => /unauthorized/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(hits.map(file => path.basename(file)), ['troubleshooting.md']);
});

test('setup.md covers the URL paste step, the unverified-app warning and the format-only check', () => {
  const doc = read('docs/setup.md');
  for (const phrase of ['ウェブアプリURL', '詳細', '安全ではない', '形式だけを確認', '公開状態は保証']) {
    assert.equal(doc.includes(phrase), true, 'setup.md missing: ' + phrase);
  }
});

test('updating.md leads with updating the existing deployment and covers manifest plus new files', () => {
  const doc = read('docs/updating.md');
  assert.equal(doc.includes('既存デプロイの更新'), true);
  assert.equal(doc.includes('新しいデプロイ'), true); // must warn against it
  assert.equal(doc.includes('appsscript.json'), true);
  assert.equal(doc.includes('マニフェスト'), true);
  assert.equal(doc.includes('ファイルを追加'), true);
});

test('troubleshooting.md covers the send quota and the unauthenticated resend path', () => {
  const doc = read('docs/troubleshooting.md');
  for (const phrase of ['クォータ', 'resend']) assert.equal(doc.includes(phrase), true, 'troubleshooting.md missing: ' + phrase);
});

test('README states the purpose, honest fit, three steps and links every recipient doc', () => {
  const readme = read('README.md');
  assert.equal(readme.includes('ひとつの Gmail アドレスに集約'), true);
  assert.equal(readme.includes('1台だけ'), true);
  assert.equal(readme.includes('コピーを作成'), true);
  for (const doc of ['docs/setup.md', 'docs/updating.md', 'docs/troubleshooting.md', 'docs/development.md', 'CHANGELOG.md']) {
    assert.equal(readme.includes('](' + doc + ')'), true, 'README missing link: ' + doc);
  }
  assert.equal(/AKfycb|script\.google\.com\/macros\/s\/[^<\s)]+\/exec/.test(readme), false);
});
