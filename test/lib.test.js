'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadLib, loadApp } = require('./helper');

test('simName_ extracts a note from a SIM slot', () => {
  const { simName_ } = loadLib();
  assert.equal(simName_('SIM1_a'), 'a');
});

test('simName_ keeps a slot name without a note', () => {
  const { simName_ } = loadLib();
  assert.equal(simName_('SIM2'), 'SIM2');
});

test('simName_ returns an empty string for empty input', () => {
  const { simName_ } = loadLib();
  assert.equal(simName_(''), '');
});

test('simName_ accepts separator variations', () => {
  const { simName_ } = loadLib();
  assert.equal(simName_('SIM 1: office'), 'office');
  assert.equal(simName_('SIM2-home'), 'home');
  assert.equal(simName_('SIM 3 work'), 'work');
});

test('simName_ trims surrounding whitespace', () => {
  const { simName_ } = loadLib();
  assert.equal(simName_('  SIM1_ work  '), 'work');
});

test('judge_ rejects a matching deny rule before allow rules', () => {
  const { judge_ } = loadLib();
  const sms = { from: '0120-123', body: '認証コード', device: 'phone', sim: 'main' };
  const rules = [
    { type: 'allow', field: 'body', pattern: '認証' },
    { type: 'deny', field: 'from', pattern: '^0120' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(judge_(sms, rules))), {
    pass: false,
    reason: 'deny:^0120',
  });
});

test('judge_ accepts all messages when there are no allow rules', () => {
  const { judge_ } = loadLib();
  assert.equal(judge_({ body: 'hello' }, []).pass, true);
});

test('judge_ accepts a matching allow rule', () => {
  const { judge_ } = loadLib();
  const result = judge_({ body: 'Your code is 1234' }, [
    { type: 'allow', field: 'body', pattern: 'code' },
  ]);
  assert.equal(result.pass, true);
  assert.equal(result.reason, 'allow:code');
});

test('judge_ rejects a message that matches no allow rule', () => {
  const { judge_ } = loadLib();
  const result = judge_({ body: 'hello' }, [
    { type: 'allow', field: 'body', pattern: 'code' },
  ]);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'no-allow-match');
});

test('judge_ treats an invalid regular expression as no match', () => {
  const { judge_ } = loadLib();
  const result = judge_({ body: 'hello' }, [
    { type: 'allow', field: 'body', pattern: '[' },
  ]);
  assert.equal(result.pass, false);
});

test('judge_ treats a missing field as no match', () => {
  const { judge_ } = loadLib();
  const result = judge_({ body: 'hello' }, [
    { type: 'allow', field: 'unknown', pattern: 'hello' },
  ]);
  assert.equal(result.pass, false);
});

test('parseRuleRows_ validates and normalizes rows', () => {
  const { parseRuleRows_ } = loadLib();
  const rows = [
    ['type', 'field', 'pattern', 'memo'],
    ['', '', '', 'empty'],
    ['block', 'body', 'x', 'invalid type'],
    ['allow', 'unknown', 'x', 'invalid field'],
    [' ALLOW ', ' BODY ', ' Code ', 'valid'],
    ['deny', 'from', '^0120', 'valid'],
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(parseRuleRows_(rows))), [
    { type: 'allow', field: 'body', pattern: 'Code' },
    { type: 'deny', field: 'from', pattern: '^0120' },
  ]);
});

test('parseRequest_ parses a JSON body', () => {
  const { parseRequest_ } = loadLib();
  const result = parseRequest_({
    postData: { contents: '{"from":"123","body":"hello"}' },
    parameter: {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { from: '123', body: 'hello' });
});

test('parseRequest_ falls back to form parameters', () => {
  const { parseRequest_ } = loadLib();
  const parameter = { from: '123', body: 'hello' };
  assert.equal(parseRequest_({ postData: { contents: 'from=123' }, parameter }), parameter);
});

test('parseRequest_ rejects an empty body', () => {
  const { parseRequest_ } = loadLib();
  assert.throws(() => parseRequest_({}), /empty body/);
});

test('testSend passes loaded rules to judge_', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.js'), 'utf8');
  const testSendBody = code.match(/function testSend\(\) \{([\s\S]*?)\n\}/);
  assert.ok(testSendBody, 'testSend function not found');
  assert.match(testSendBody[1], /judge_\(sms, loadRules_\(\)\)/);
});

const encodeBase64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('buildTextMime_ builds an RFC822 text message with an encoded subject', () => {
  const { buildTextMime_ } = loadLib();
  const mime = buildTextMime_(
    'me@example.com',
    'SMS転送 テスト',
    'first\nsecond',
    encodeBase64,
  );

  assert.match(mime, /^To: me@example\.com\r\n/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?U01T6Lui6YCBIOODhuOCueODiA==\?=\r\n/);
  assert.match(mime, /Content-Type: text\/plain; charset=UTF-8\r\n/);
  assert.match(mime, /\r\n\r\nfirst\r\nsecond$/);
  assert.doesNotMatch(mime, /SMS転送 テスト/);
  assert.doesNotMatch(mime, /(?<!\r)\n/);
});

test('buildTextMime_ strips line breaks from address and subject headers', () => {
  const { buildTextMime_ } = loadLib();
  const mime = buildTextMime_(
    'me@example.com\r\nBcc: attacker@example.com',
    'safe\r\nBcc: attacker@example.com',
    'body',
    encodeBase64,
  );

  assert.doesNotMatch(mime, /\r\nBcc:/);
});

test('buildMultipartMime_ contains plain and HTML alternatives with a closed boundary', () => {
  const { buildMultipartMime_ } = loadLib();
  const mime = buildMultipartMime_(
    'me@example.com',
    '設定手順',
    'plain text',
    '<p>html text</p>',
    'sms-forwarder-boundary',
    encodeBase64,
  );

  assert.match(mime, /Content-Type: multipart\/alternative; boundary="sms-forwarder-boundary"/);
  assert.match(mime, /--sms-forwarder-boundary\r\nContent-Type: text\/plain; charset=UTF-8/);
  assert.match(mime, /\r\n\r\nplain text\r\n--sms-forwarder-boundary/);
  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(mime, /\r\n\r\n<p>html text<\/p>\r\n--sms-forwarder-boundary--$/);
});

test('resolveLabelName_ supports all label modes and prefixes', () => {
  const { resolveLabelName_ } = loadLib();
  const sms = { sim: ' SIM1_work ', device: ' Pixel 9 ' };
  const cases = [
    [{ LABEL_MODE: 'sim', LABEL_PREFIX: 'SMS' }, 'SMS/work'],
    [{ LABEL_MODE: 'sim', LABEL_PREFIX: '' }, 'work'],
    [{ LABEL_MODE: 'device', LABEL_PREFIX: 'SMS' }, 'SMS/Pixel 9'],
    [{ LABEL_MODE: 'device', LABEL_PREFIX: '' }, 'Pixel 9'],
    [{ LABEL_MODE: 'fixed', LABEL_NAME: ' Bank ', LABEL_PREFIX: 'SMS' }, 'SMS/Bank'],
    [{ LABEL_MODE: 'fixed', LABEL_NAME: ' Bank ', LABEL_PREFIX: '' }, 'Bank'],
    [{ LABEL_MODE: 'none', LABEL_PREFIX: 'SMS' }, ''],
    [{ LABEL_MODE: 'none', LABEL_PREFIX: '' }, ''],
  ];

  for (const [settings, expected] of cases) {
    assert.equal(resolveLabelName_(sms, settings), expected);
  }
});

test('resolveLabelName_ does not create a prefix-only label', () => {
  const { resolveLabelName_ } = loadLib();
  assert.equal(resolveLabelName_({ sim: '', device: '' }, {
    LABEL_MODE: 'sim',
    LABEL_PREFIX: ' SMS ',
  }), '');
  assert.equal(resolveLabelName_({}, {
    LABEL_MODE: 'fixed',
    LABEL_NAME: '   ',
    LABEL_PREFIX: 'SMS',
  }), '');
});

test('parseSettingsRows_ maps Japanese items and display values to internal settings', () => {
  const { parseSettingsRows_ } = loadLib();
  const rows = [
    ['項目', '値', '説明'],
    [' 合言葉 ', ' secret ', ''],
    ['転送先アドレス', '', ''],
    ['ラベルの付け方', ' 固定名 ', ''],
    ['固定ラベル名', ' Bank ', ''],
    ['親ラベル', ' SMS ', ''],
    ['ログの保持行数', ' 1000 ', ''],
    ['未認証も記録する', ' はい ', ''],
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(parseSettingsRows_(rows))), {
    TOKEN: 'secret',
    MAIL_TO: '',
    LABEL_MODE: 'fixed',
    LABEL_NAME: 'Bank',
    LABEL_PREFIX: 'SMS',
    LOG_MAX_ROWS: '1000',
    LOG_UNAUTHORIZED: 'yes',
  });
});

test('parseSettingsRows_ ignores empty rows, unknown items, and unknown select values', () => {
  const { parseSettingsRows_ } = loadLib();
  const rows = [
    ['項目', '値', '説明'],
    ['', '', ''],
    ['知らない項目', 'value', ''],
    ['ラベルの付け方', '自動', ''],
    ['未認証も記録する', 'たぶん', ''],
    ['親ラベル', '', ''],
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(parseSettingsRows_(rows))), {
    LABEL_PREFIX: '',
  });
});

test('parseSettingsRows_ accepts every label and boolean display choice', () => {
  const { parseSettingsRows_ } = loadLib();
  const labelModes = {
    SIM名: 'sim',
    端末名: 'device',
    固定名: 'fixed',
    付けない: 'none',
  };
  for (const [display, internal] of Object.entries(labelModes)) {
    assert.equal(parseSettingsRows_([['項目', '値'], ['ラベルの付け方', display]]).LABEL_MODE, internal);
  }
  assert.equal(parseSettingsRows_([['項目', '値'], ['未認証も記録する', 'いいえ']]).LOG_UNAUTHORIZED, 'no');
});

test('manifest enables Gmail v1 with only the planned scopes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gas', 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [
    { userSymbol: 'Gmail', version: 'v1', serviceId: 'gmail' },
  ]);
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/spreadsheets.currentonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/script.container.ui',
  ]);
});

test('Code.js uses the Gmail advanced service without legacy search-and-sleep labeling', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.js'), 'utf8');
  assert.doesNotMatch(code, /GmailApp/);
  assert.doesNotMatch(code, /function labelLatest_/);
  assert.doesNotMatch(code, /Utilities\.sleep/);
  assert.match(code, /Gmail\.Users\.Messages\.send/);
  assert.match(code, /Gmail\.Users\.Messages\.modify/);
  assert.match(code, /@OnlyCurrentDoc/);
});

test('parseSettingsRows_ leaves an empty token out so legacy settings can supply it', () => {
  const { parseSettingsRows_ } = loadLib();
  assert.equal(Object.hasOwn(parseSettingsRows_([['項目', '値'], ['合言葉', ' ']]), 'TOKEN'), false);
});

test('addLabel_ recovers when another execution creates the same label first', () => {
  let lists = 0;
  let modified;
  const { addLabel_ } = loadApp({
    Gmail: { Users: {
      Labels: {
        list: () => ({ labels: ++lists === 1 ? [] : [{ id: 'label-1', name: 'SMS/work' }] }),
        create: () => { throw new Error('already exists'); },
      },
      Messages: { modify: (request, user, messageId) => { modified = { request, user, messageId }; } },
    } },
  });
  addLabel_('message-1', 'SMS/work');
  assert.deepEqual(JSON.parse(JSON.stringify(modified)), {
    request: { addLabelIds: ['label-1'] }, user: 'me', messageId: 'message-1',
  });
});

test('addLabel_ does not hide a label creation failure without an existing label', () => {
  const { addLabel_ } = loadApp({
    Gmail: { Users: { Labels: {
      list: () => ({ labels: [] }),
      create: () => { throw new Error('permission denied'); },
    } } },
  });
  assert.throws(() => addLabel_('message-1', 'SMS/work'), /permission denied/);
});

test('sendMail_ keeps a successful send successful even if labeling fails', () => {
  let sends = 0;
  let warnings = 0;
  const { sendMail_ } = loadApp({
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: encodeBase64,
      base64EncodeWebSafe: encodeBase64,
    },
    console: { warn: () => { warnings++; } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: () => null,
      setProperty: () => {},
    }) },
    Gmail: { Users: {
      Messages: {
        send: () => { sends++; return { id: 'message-1' }; },
        get: () => ({ payload: { headers: [] } }),
      },
      Labels: { list: () => { throw new Error('label API unavailable'); } },
    } },
  });
  assert.doesNotThrow(() => sendMail_({ from: '0000', sim: 'work', body: 'text' }, {
    MAIL_TO: 'me@example.com', LABEL_MODE: 'sim', LABEL_PREFIX: 'SMS',
  }));
  assert.equal(sends, 1);
  assert.equal(warnings, 1);
});

test('loadSettings_ avoids legacy properties when the settings sheet supplies all keys', () => {
  const rows = [
    ['項目', '値'], ['合言葉', 'test-value'], ['転送先アドレス', ''],
    ['ラベルの付け方', 'SIM名'], ['固定ラベル名', ''], ['親ラベル', 'SMS'],
    ['ログの保持行数', ''], ['未認証も記録する', 'いいえ'],
  ];
  const { loadSettings_ } = loadApp({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({
      getDataRange: () => ({ getValues: () => rows }),
    }) }) },
    PropertiesService: { getScriptProperties: () => { throw new Error('unnecessary legacy read'); } },
  });
  assert.equal(loadSettings_().LABEL_MODE, 'sim');
});

test('addLabel_ reuses labels created within the same execution', () => {
  let lists = 0;
  let creates = 0;
  const { addLabel_ } = loadApp({
    Gmail: { Users: {
      Labels: {
        list: () => { lists++; return { labels: [] }; },
        create: ({ name }) => { creates++; return { id: 'label-1', name }; },
      },
      Messages: { modify: () => {} },
    } },
  });
  addLabel_('message-1', 'SMS/work');
  addLabel_('message-2', 'SMS/work');
  assert.equal(lists, 1);
  assert.equal(creates, 1);
});

test('every application entry point resets execution-scoped label caches', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.js'), 'utf8');
  for (const name of ['doPost', 'doGet', 'setup', 'testSend']) {
    assert.ok(new RegExp('function ' + name + '\\([^)]*\\) \\{\\s*labelCache_ = null;').test(code), name + ' must reset the cache');
  }
});

test('VERSION identifies the code revision for release matching', () => {
  const { VERSION } = loadLib();
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('parseSettingsRows_ accepts the starred required-item labels', () => {
  const { parseSettingsRows_ } = loadLib();
  const rows = [
    ['項目（* は必須）', '値', '説明'],
    ['合言葉*', ' secret ', ''],
    ['ウェブアプリURL*', 'https://script.google.com/macros/s/x/exec', ''],
    ['転送先アドレス', '', ''],
  ];
  const settings = parseSettingsRows_(rows);
  assert.equal(settings.TOKEN, 'secret');
  assert.equal(settings.WEB_APP_URL, 'https://script.google.com/macros/s/x/exec');
});

test('resolveSetupToken_ keeps the token on a starred 合言葉 row', () => {
  const { resolveSetupToken_ } = loadLib();
  const generate = () => { throw new Error('must not generate'); };
  assert.equal(resolveSetupToken_([['項目（* は必須）', '値'], ['合言葉*', 'existing-token']], null, generate), 'existing-token');
});

test('parseSettingsRows_ maps the web app URL item to WEB_APP_URL', () => {
  const { parseSettingsRows_ } = loadLib();
  const url = 'https://script.google.com/macros/s/abc123/exec';
  assert.equal(parseSettingsRows_([['項目', '値'], ['ウェブアプリURL', ' ' + url + ' ']]).WEB_APP_URL, url);
  assert.equal(Object.hasOwn(parseSettingsRows_([['項目', '値'], ['ウェブアプリURL', '']]), 'WEB_APP_URL'), true);
});

test('isWebAppUrl_ accepts only the published web app URL form', () => {
  const { isWebAppUrl_ } = loadLib();
  assert.equal(isWebAppUrl_('https://script.google.com/macros/s/AKfyc_x/exec'), true);
  assert.equal(isWebAppUrl_('  https://script.google.com/macros/s/x/exec  '), true);
  for (const url of ['', null, 'https://script.google.com/macros/s/x/dev',
    'http://script.google.com/macros/s/x/exec', 'https://evil.example/macros/s/x/exec',
    'https://script.google.com/macros/s/x', 'https://script.google.com/macros/s/x/exec?a=1',
    'https://script.google.com/macros/s/x/exec/extra', 'https://script.google.com/macros/s//exec']) {
    assert.equal(isWebAppUrl_(url), false, String(url));
  }
});

test('loadSettings_ reads WEB_APP_URL only from the sheet, never from legacy properties', () => {
  const loadAppWith = rows => loadApp({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({
      getDataRange: () => ({ getValues: () => rows }),
    }) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ WEB_APP_URL: 'https://script.google.com/macros/s/legacy/exec' }),
    }) },
  });
  const url = 'https://script.google.com/macros/s/sheet/exec';
  assert.equal(loadAppWith([['項目', '値'], ['ウェブアプリURL', url]]).loadSettings_().WEB_APP_URL, url);
  assert.equal(loadAppWith([['項目', '値']]).loadSettings_().WEB_APP_URL, '');
});

test('resolveSetupToken_ distinguishes first migration from explicit regeneration', () => {
  const { resolveSetupToken_ } = loadLib();
  const generate = () => 'new-value';
  assert.equal(resolveSetupToken_([['項目', '値']], 'old-value', generate), 'old-value');
  assert.equal(resolveSetupToken_([['項目', '値'], ['合言葉', '']], 'old-value', generate), 'new-value');
  assert.equal(resolveSetupToken_([['項目', '値'], ['合言葉', 'current-value']], 'old-value', generate), 'current-value');
  assert.equal(resolveSetupToken_([['項目', '値']], '', generate), 'new-value');
});

function receiverFixture(settings = {}) {
  const logs = [];
  let sends = 0;
  const cache = new Map();
  let held = false;
  const lock = {
    waitLock() { held = true; },
    releaseLock() { held = false; },
  };
  const app = loadApp({ console: { error() {}, warn() {} },
    SpreadsheetApp: { flush() {}, getActiveSpreadsheet: () => ({ getSheetByName: () => ({}) }) },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => ({
      get: key => cache.get(key) || null,
      put: (key, value) => { cache.set(key, value); },
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, text) => Array.from(require('node:crypto').createHash(algorithm).update(text).digest()),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
    },
  });
  app.loadSettings_ = () => ({ TOKEN: 'fixture-secret', LOG_UNAUTHORIZED: 'no', ...settings });
  app.loadRules_ = () => [];
  app.sendMail_ = () => { sends++; };
  app.appendLog_ = (sms, mailed, reason) => { logs.push({ sms, mailed, reason }); };
  app.json_ = value => value;
  return { app, logs, cache, lock, held: () => held, sends: () => sends };
}

function receiverEvent(extra = {}) {
  return { postData: { contents: JSON.stringify({
    token: 'fixture-secret', device: 'fixture-device', sim: 'SIM1_fixture',
    from: 'fixture-number', body: 'fixture-body', received_at: '2026-09-16T00:00:00Z', ...extra,
  }) } };
}

test('doPost does not log unauthorized requests by default', () => {
  const f = receiverFixture();
  assert.equal(f.app.doPost(receiverEvent({ token: 'wrong' })).ok, false);
  assert.equal(f.logs.length, 0);
  assert.equal(f.sends(), 0);
});

test('doPost does not log errors before authentication', () => {
  const f = receiverFixture();
  assert.equal(f.app.doPost({}).ok, false);
  assert.equal(f.logs.length, 0);
});

test('doPost diagnostic unauthorized logs contain no request values', () => {
  const f = receiverFixture({ LOG_UNAUTHORIZED: 'yes' });
  f.app.doPost(receiverEvent({ token: 'wrong', 'fixture-private-key': 'private' }));
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /fixture-number|fixture-body|fixture-device|fixture-private-key|wrong/);
});

test('doPost sends the same SMS only once during cache retention', () => {
  const f = receiverFixture();
  assert.equal(f.app.doPost(receiverEvent()).mailed, true);
  assert.equal(f.app.doPost(receiverEvent()).reason, 'duplicate');
  assert.equal(f.sends(), 1);
  assert.equal(f.held(), false);
  assert.doesNotMatch(JSON.stringify([...f.cache]), /fixture-secret|fixture-body|fixture-number/);
});

test('doPost sends different received times separately', () => {
  const f = receiverFixture();
  f.app.doPost(receiverEvent());
  f.app.doPost(receiverEvent({ received_at: '2026-09-16T00:00:01Z' }));
  assert.equal(f.sends(), 2);
});

test('doPost permits retry after a send failure', () => {
  const f = receiverFixture();
  const send = f.app.sendMail_;
  f.app.sendMail_ = () => { throw new Error('send failed'); };
  assert.equal(f.app.doPost(receiverEvent()).ok, false);
  f.app.sendMail_ = send;
  assert.equal(f.app.doPost(receiverEvent()).mailed, true);
  assert.equal(f.held(), false);
});

test('doPost does not write or send without a lock', () => {
  const f = receiverFixture();
  f.lock.waitLock = () => { throw new Error('busy'); };
  assert.equal(f.app.doPost(receiverEvent()).ok, false);
  assert.equal(f.logs.length, 0);
  assert.equal(f.sends(), 0);
});

test('doPost keeps a sent message successful when logging fails', () => {
  const f = receiverFixture();
  f.app.appendLog_ = () => { throw new Error('log unavailable'); };
  assert.equal(f.app.doPost(receiverEvent()).ok, true);
  assert.equal(f.app.doPost(receiverEvent()).mailed, false);
  assert.equal(f.sends(), 1);
});

test('doPost keeps a sent message successful when cache recording fails', () => {
  const f = receiverFixture();
  f.app.CacheService.getScriptCache = () => ({ get: () => null, put() { throw new Error('cache unavailable'); } });
  assert.equal(f.app.doPost(receiverEvent()).mailed, true);
  assert.equal(f.held(), false);
});

test('duplicateFingerprint_ separates message fields unambiguously', () => {
  const { duplicateFingerprint_ } = loadLib();
  const sms = { device: 'a', sim: 'b', from: 'c', body: 'd', receivedAt: 'e' };
  assert.equal(duplicateFingerprint_(sms), duplicateFingerprint_({ ...sms }));
  for (const key of Object.keys(sms)) {
    assert.notEqual(duplicateFingerprint_(sms), duplicateFingerprint_({ ...sms, [key]: sms[key] + 'x' }));
  }
  assert.notEqual(duplicateFingerprint_({ device: 'a|b', sim: 'c' }), duplicateFingerprint_({ device: 'a', sim: 'b|c' }));
});

test('resolveLogMaxRows_ accepts positive integers and falls back safely', () => {
  const { resolveLogMaxRows_ } = loadLib();
  assert.equal(resolveLogMaxRows_('2'), 2);
  for (const value of ['', '0', '-1', '1.5', 'abc', 'Infinity', '9007199254740992']) {
    assert.equal(resolveLogMaxRows_(value), 1000);
  }
});

test('logExcessRows_ excludes the header from the retention count', () => {
  const { logExcessRows_ } = loadLib();
  assert.equal(logExcessRows_(1, 2), 0);
  assert.equal(logExcessRows_(3, 2), 0);
  assert.equal(logExcessRows_(5, 2), 2);
});

test('appendLog_ deletes only oldest data rows under its own lock', () => {
  const rows = [Array.from({ length: 8 }, (_, i) => 'header-' + i), ['old'], ['keep']];
  let held = false;
  const lock = { waitLock() { held = true; }, releaseLock() { held = false; } };
  const app = loadApp({
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: { flush() { assert.equal(held, true); } },
  });
  app.getSheet_ = () => ({
    appendRow(row) { assert.equal(held, true); rows.push(Array.from(row)); },
    getLastRow: () => rows.length,
    deleteRows(start, count) { assert.equal(held, true); rows.splice(start - 1, count); },
  });
  app.appendLog_({ loggedAt: new Date(), receivedAt: '', device: '', sim: '', from: '0000', body: 'new' }, true, 'sent', { LOG_MAX_ROWS: '2' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], 'header-0');
  assert.equal(rows[1][0], 'keep');
  assert.equal(rows[2][3], "'0000");
  assert.equal(held, false);
});

test('appendLog_ does not reacquire a caller-owned lock', () => {
  const app = loadApp({ LockService: { getScriptLock() { throw new Error('reacquired'); } } });
  app.getSheet_ = () => ({ appendRow() {}, getLastRow: () => 1 });
  assert.doesNotThrow(() => app.appendLog_({}, false, 'duplicate', { LOG_MAX_ROWS: '2' }, true));
});

test('doPost keeps a sent message successful when sheet flush fails', () => {
  const f = receiverFixture();
  f.app.SpreadsheetApp.flush = () => { throw new Error('flush failed'); };
  assert.equal(f.app.doPost(receiverEvent()).mailed, true);
  assert.equal(f.held(), false);
});

test('doPost rechecks delivery after cache eviction', () => {
  const f = receiverFixture();
  f.app.doPost(receiverEvent());
  f.cache.clear();
  assert.equal(f.app.doPost(receiverEvent()).mailed, true);
  assert.equal(f.sends(), 2);
});

test('doPost protects send and cache recording inside one lock', () => {
  const f = receiverFixture();
  const send = f.app.sendMail_;
  f.app.sendMail_ = () => { assert.equal(f.held(), true); send(); };
  f.app.CacheService.getScriptCache = () => ({
    get() { assert.equal(f.held(), true); return null; },
    put() { assert.equal(f.held(), true); },
  });
  assert.equal(f.app.doPost(receiverEvent()).mailed, true);
});

test('buildTextMime_ adds threading headers when refs are given', () => {
  const { buildTextMime_ } = loadLib();
  const mime = buildTextMime_(
    'me@example.com',
    '[SMS転送]',
    'body',
    encodeBase64,
    { inReplyTo: '<m1@mail.gmail.com>', references: '<m1@mail.gmail.com>' },
  );
  assert.match(mime, /^In-Reply-To: <m1@mail\.gmail\.com>\r$/m);
  assert.match(mime, /^References: <m1@mail\.gmail\.com>\r$/m);
});

test('sendMail_ uses one fixed subject so all forwards share a thread', () => {
  const raws = [];
  const { sendMail_ } = loadApp({
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: encodeBase64,
      base64EncodeWebSafe: (v) => Buffer.from(v, 'utf8').toString('base64url'),
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: () => null,
      setProperty: () => {},
    }) },
    Gmail: { Users: {
      Messages: { send: (req) => { raws.push(req.raw); return { id: 'm1' }; } },
      Labels: { list: () => ({ labels: [] }), create: () => ({ id: 'l' }) },
    } },
  });
  sendMail_({ from: '090-1111', sim: 'a', body: 'x' }, {
    MAIL_TO: 'me@example.com', LABEL_MODE: 'sim', LABEL_PREFIX: 'SMS',
  });
  const mime = Buffer.from(raws[0], 'base64url').toString('utf8');
  const subject = mime.match(/^Subject: =\?UTF-8\?B\?(.+?)\?=/m)[1];
  assert.equal(Buffer.from(subject, 'base64').toString('utf8'), '[SMS転送]');
});

test('sendMail_ stores a thread anchor and chains the next mail into it', () => {
  const sends = [];
  const props = {};
  const { sendMail_ } = loadApp({
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: encodeBase64,
      base64EncodeWebSafe: (v) => Buffer.from(v, 'utf8').toString('base64url'),
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props[k] ?? null,
      setProperty: (k, v) => { props[k] = v; },
    }) },
    Gmail: { Users: {
      Messages: {
        send: (req) => { sends.push(req); return { id: 'm' + sends.length, threadId: 't-1' }; },
        get: (user, id) => ({ payload: { headers: [{ name: 'Message-Id', value: '<' + id + '@mail.gmail.com>' }] } }),
      },
      Labels: { list: () => ({ labels: [] }), create: () => ({ id: 'l' }) },
    } },
  });
  const settings = { MAIL_TO: 'me@example.com', LABEL_MODE: 'sim', LABEL_PREFIX: 'SMS' };
  sendMail_({ from: '0000', sim: 'a', body: 'one' }, settings);
  sendMail_({ from: '1111', sim: 'b', body: 'two' }, settings);

  assert.equal(props.MAIL_THREAD_ID, 't-1');
  assert.equal(props.MAIL_MSG_ID, '<m2@mail.gmail.com>');
  assert.equal(sends[1].threadId, 't-1');
  const mime = Buffer.from(sends[1].raw, 'base64url').toString('utf8');
  assert.match(mime, /^In-Reply-To: <m1@mail\.gmail\.com>/m);
  assert.match(mime, /^References: <m1@mail\.gmail\.com>/m);
});

test('sendMail_ falls back to a fresh thread when the stored threadId is stale', () => {
  const sends = [];
  const props = { MAIL_THREAD_ID: 't-old', MAIL_MSG_ID: '<old@x>' };
  const { sendMail_ } = loadApp({
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: encodeBase64,
      base64EncodeWebSafe: (v) => Buffer.from(v, 'utf8').toString('base64url'),
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props[k] ?? null,
      setProperty: (k, v) => { props[k] = v; },
    }) },
    Gmail: { Users: {
      Messages: {
        send: (req) => {
          sends.push(req);
          if (req.threadId === 't-old') throw new Error('thread not found');
          return { id: 'm9', threadId: 't-new' };
        },
        get: () => ({ payload: { headers: [{ name: 'Message-Id', value: '<m9@mail.gmail.com>' }] } }),
      },
      Labels: { list: () => ({ labels: [] }), create: () => ({ id: 'l' }) },
    } },
  });
  sendMail_({ from: '0000', sim: 'a', body: 'x' }, {
    MAIL_TO: 'me@example.com', LABEL_MODE: 'sim', LABEL_PREFIX: 'SMS',
  });
  assert.equal(sends.length, 2);
  assert.equal(sends[1].threadId, undefined);
  assert.equal(props.MAIL_THREAD_ID, 't-new');
});
