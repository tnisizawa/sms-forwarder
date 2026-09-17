'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('local clasp config is ignored without ignoring its example', () => {
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '.clasp.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(ignored.trim(), '.clasp.json');
  const result = require('node:child_process').spawnSync('git', ['check-ignore', '.clasp.json.example'], { cwd: root });
  assert.equal(result.status, 1);
});

test('clasp example contains only blank identities and the GAS source directory', () => {
  const config = JSON.parse(read('.clasp.json.example'));
  assert.deepEqual(config, { scriptId: '', rootDir: 'gas', parentId: '' });
  assert.equal(fs.existsSync(path.join(root, config.rootDir, 'appsscript.json')), true);
});

test('README does not publish a deployment identity or a concrete web app URL', () => {
  assert.equal(/AKfycb|script\.google\.com\/macros/.test(read('README.md')), false);
});

test('the self-authored GAS package has an MIT license', () => {
  const license = read('LICENSE');
  assert.equal(license.startsWith('MIT License'), true);
  assert.equal(license.includes('Permission is hereby granted, free of charge'), true);
  assert.equal(license.includes('SMS Forwarder contributors'), true);
});

test('README distinguishes the separately distributed Android app from this package', () => {
  assert.equal(read('README.md').includes('SmsForwarderアプリは同梱しません'), true);
});

test('docs retain the clasp identity example and the existing-deployment update path', () => {
  const development = read('docs/development.md');
  assert.equal(development.includes('.clasp.json.example'), true);
  assert.equal(development.includes('clasp deploy -i <deploymentId>'), true);
  assert.equal(read('docs/updating.md').includes('既存デプロイの更新'), true);
  assert.equal(read('README.md').includes('settings'), true);
});
