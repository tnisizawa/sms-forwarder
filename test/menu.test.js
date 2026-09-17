'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gasDir = path.join(__dirname, '..', 'gas');
const plain = value => JSON.parse(JSON.stringify(value));

// Only these fake GAS boundaries exist in the VM: no require, process, fetch or credentials.
function fixture(initial = {}, old = {}) {
  let held = false;
  let uuid = 0;
  const calls = { writes: 0, created: [], logs: [], formats: [], validations: [], alerts: [], menu: [] };
  const props = { ...old };
  const sheets = {};
  const write = () => { assert.equal(held, true, 'initialization write without lock'); calls.writes++; };
  function makeSheet(name, rows) {
    const data = plain(rows);
    const protections = [];
    const sheet = {
      data, protections,
      getLastRow: () => data.length,
      getLastColumn: () => Math.max(0, ...data.map(row => row.length)),
      getMaxRows: () => 1000,
      getMaxColumns: () => 26,
      getDataRange: () => ({ getValues: () => plain(data.length ? data : [['']]) }),
      appendRow(row) { write(); data.push(plain(row)); },
      insertRowBefore(row) { write(); data.splice(row - 1, 0, []); },
      setFrozenRows(n) { write(); assert.equal(n, 1); },
      setColumnWidth(col, width) { write(); calls.formats.push([name, 'width', col, width]); },
      getProtections: () => protections,
      getRange(row, col, height = 1, width = 1) {
        const key = typeof row === 'string' ? row : [row, col, height, width].join(':');
        const range = {
          getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => (data[row - 1 + i] || [])[col - 1 + j] ?? '')),
          getValue: () => (data[row - 1] || [])[col - 1] ?? '',
          setValues(values) { write(); values.forEach((cells, i) => { data[row - 1 + i] ||= []; cells.forEach((v, j) => { data[row - 1 + i][col - 1 + j] = v; }); }); return range; },
          setValue(v) { return range.setValues([[v]]); },
          setFontWeight(v) { write(); calls.formats.push([name, key, 'weight', v]); return range; },
          setNumberFormat(v) { write(); calls.formats.push([name, key, 'number', v]); return range; },
          setWrap(v) { write(); calls.formats.push([name, key, 'wrap', v]); return range; },
          setDataValidation(v) { write(); calls.validations.push([name, key, plain(v)]); return range; },
          protect() { write(); const p = { getDescription: () => p.description, setDescription(v) { p.description = v; return p; }, setWarningOnly(v) { p.warning = v; return p; } }; protections.push(p); return p; },
        };
        return range;
      },
    };
    return sheet;
  }
  Object.entries(initial).forEach(([name, rows]) => { sheets[name] = makeSheet(name, rows); });
  const ss = { getSheetByName: name => sheets[name] || null, insertSheet(name) { write(); calls.created.push(name); return sheets[name] = makeSheet(name, []); } };
  const lock = { waitLock() { held = true; }, releaseLock() { held = false; } };
  const ui = {
    createMenu(name) { calls.menu.push(name); return { addItem(label, handler) { calls.menu.push([label, handler]); return this; }, addToUi() { calls.menu.push('shown'); } }; },
    alert(message) { assert.equal(held, false); calls.alerts.push(message); },
  };
  const validation = () => ({ values: null, invalid: null, requireValueInList(v) { this.values = plain(v); return this; }, setAllowInvalid(v) { this.invalid = v; return this; }, build() { return { values: this.values, invalid: this.invalid }; } });
  const app = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ui, flush() {}, newDataValidation: validation, ProtectionType: { RANGE: 'range' } },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), getProperty: name => props[name] || null, deleteProperty(name) { write(); delete props[name]; }, setProperty(name, value) { props[name] = value; } }) },
    LockService: { getScriptLock: () => lock },
    Utilities: { getUuid: () => 'generated-' + (++uuid) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) },
    Logger: { log(v) { calls.logs.push(v); } },
    Gmail: { Users: { Messages: { send() { throw new Error('outbound denied'); } } } },
    console: { warn() {}, error() {} },
  });
  for (const name of fs.readdirSync(gasDir).filter(name => name.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(gasDir, name), 'utf8'), app, { filename: name });
  }
  return { app, sheets, calls, props, lock, get held() { return held; }, snapshot: () => plain(Object.fromEntries(Object.entries(sheets).map(([name, s]) => [name, s.data]))) };
}

const settingRow = (f, item) => f.sheets.settings.data.findIndex(row => f.app.normalizeSettingName_(row[0]) === item);

test('initSheets reproduces the three sheet schemas in an empty book', () => {
  const f = fixture(); f.app.initSheets();
  assert.deepEqual(Object.keys(f.sheets).sort(), ['filter', 'log', 'settings']);
  assert.deepEqual(f.sheets.log.data[0], ['logged_at', 'received_at', 'device', 'from', 'body', 'mailed', 'reason', 'sim']);
  assert.deepEqual(f.sheets.settings.data[0], ['項目（* は必須）', '値', '説明']);
  assert.deepEqual(f.sheets.filter.data[0], ['type', 'field', 'pattern', 'memo']);
  assert.equal(f.sheets.settings.data.length, 10);
  assert.equal(f.sheets.filter.data.length, 3);
  assert.equal(f.sheets.filter.data.slice(1).every(row => row[0] === ''), true);
  assert.equal(f.held, false);
});

test('initSheets is value-idempotent including examples and protections', () => {
  const f = fixture(); f.app.initSheets(); const before = f.snapshot(); f.app.initSheets();
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.sheets.settings.protections.length, 2);
  assert.equal(f.calls.created.length, 3);
});

test('initSheets preserves existing values, active rules and log rows', () => {
  const f = fixture(); f.app.initSheets();
  f.sheets.settings.data[settingRow(f, '合言葉')][1] = 'kept-token';
  f.sheets.settings.data[settingRow(f, '転送先アドレス')][1] = 'receiver@example.invalid';
  f.sheets.filter.data.push(['deny', 'body', 'blocked', 'custom']);
  f.sheets.log.data.push(['date', 'date', 'device', '0000', 'body', 'no', 'denied', 'sim']);
  const before = f.snapshot(); f.app.initSheets(); assert.deepEqual(f.snapshot(), before);
});

test('initSheets migrates legacy settings without clearing unrelated properties', () => {
  const f = fixture({}, { TOKEN: 'legacy-token', MAIL_TO: 'legacy@example.invalid', LABEL_MODE: 'device', SETUP_MAIL_SENT: 'kept' });
  f.app.initSheets(); const settings = f.app.loadSettings_();
  assert.equal(settings.TOKEN, 'legacy-token'); assert.equal(settings.MAIL_TO, 'legacy@example.invalid'); assert.equal(settings.LABEL_MODE, 'device');
  assert.deepEqual(f.props, { SETUP_MAIL_SENT: 'kept' });
});

test('initSheets regenerates an explicitly cleared token', () => {
  const f = fixture(); f.app.initSheets();
  const row = settingRow(f, '合言葉'); const token = f.sheets.settings.data[row][1];
  f.sheets.settings.data[row][1] = ''; f.props.TOKEN = 'stale'; f.app.initSheets();
  assert.notEqual(f.sheets.settings.data[row][1], token); assert.notEqual(f.sheets.settings.data[row][1], 'stale');
});

test('initSheets checks all headers before writing any sheet', () => {
  const f = fixture({ filter: [['wrong', 'field', 'pattern', 'memo'], ['deny', 'body', 'x', 'keep']] });
  const before = f.snapshot(); assert.throws(() => f.app.initSheets(), /ヘッダー/);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.calls.writes, 0); assert.equal(f.held, false);
});

test('initSheets writes nothing if the shared script lock is unavailable', () => {
  const f = fixture(); f.lock.waitLock = () => { throw new Error('busy'); };
  assert.throws(() => f.app.initSheets(), /busy/); assert.equal(f.calls.writes, 0);
});

test('receiver sheet lookup cannot create missing sheets', () => {
  const f = fixture(); assert.throws(() => f.app.getSheet_('log', []), /初期設定/); assert.deepEqual(f.calls.created, []);
});

test('setup delegates initialization without logging personal data', () => {
  const f = fixture(); f.app.setup(); assert.equal(f.sheets.settings.data.length, 10);
  assert.equal(f.calls.logs.some(v => /@|kept-token|generated/.test(v)), false);
});

test('initSheets separates header formatting from text, wrap and validation data ranges', () => {
  const f = fixture(); f.app.initSheets();
  assert.equal(f.calls.formats.some(v => v[0] === 'log' && v[1] === '2:4:999:1' && v[2] === 'number' && v[3] === '@'), true);
  assert.equal(f.calls.formats.some(v => v[0] === 'log' && v[1] === '2:5:999:1' && v[2] === 'wrap' && v[3] === true), true);
  assert.equal(f.calls.validations.some(v => v[0] === 'filter' && v[2].values.join(',') === 'allow,deny' && v[2].invalid === false), true);
  assert.equal(f.calls.formats.filter(v => v[2] === 'weight').every(v => v[1].startsWith('1:')), true);
});

test('onOpen constructs exactly three menu items without touching settings or email', () => {
  const f = fixture(); f.app.PropertiesService = undefined; f.app.Session = undefined; f.app.onOpen();
  assert.deepEqual(f.calls.menu, ['SMS転送', ['初期設定', 'menuSetup'], ['スマホの設定手順をメールで送る', 'menuSendSetupMail'], ['テスト送信', 'menuTestSend'], 'shown']);
  assert.equal(f.calls.writes, 0);
});

test('initSheets shows the code version on the first settings row and adds a web app URL row', () => {
  const f = fixture(); f.app.initSheets();
  assert.equal(f.sheets.settings.data[1][0], 'バージョン');
  assert.equal(f.sheets.settings.data[1][1], f.app.VERSION);
  assert.equal(settingRow(f, 'ウェブアプリURL') > 0, true);
  assert.equal(f.sheets.settings.data.length, 10);
});

test('initSheets inserts the version row at the top of an existing book once', () => {
  const f = fixture({ settings: [
    ['項目', '値', '説明'], ['合言葉', 'existing-token', ''], ['転送先アドレス', 'a@example.invalid', ''],
    ['ラベルの付け方', '端末名', ''], ['固定ラベル名', '', ''], ['親ラベル', '', ''],
    ['ログの保持行数', '50', ''], ['未認証も記録する', 'はい', ''],
  ] });
  f.app.initSheets();
  assert.equal(f.sheets.settings.data[1][0], 'バージョン');
  assert.equal(settingRow(f, 'ウェブアプリURL') > 0, true);
  assert.equal(f.sheets.settings.data[settingRow(f, '合言葉')][1], 'existing-token');
  assert.equal(f.sheets.settings.data[settingRow(f, 'ログの保持行数')][1], '50');
  const before = f.snapshot(); f.app.initSheets();
  assert.deepEqual(f.snapshot(), before);
  for (const item of ['バージョン', 'ウェブアプリURL']) {
    assert.equal(f.sheets.settings.data.filter(row => f.app.normalizeSettingName_(row[0]) === item).length, 1);
  }
});

test('initSheets marks required items with a star and writes the legend in the header', () => {
  const f = fixture(); f.app.initSheets();
  assert.equal(f.sheets.settings.data[0][0], '項目（* は必須）');
  const names = f.sheets.settings.data.slice(1).map(row => row[0]);
  assert.equal(names.includes('合言葉*'), true);
  assert.equal(names.includes('ウェブアプリURL*'), true);
  assert.equal(names.some(name => /\*$/.test(name) && !['合言葉*', 'ウェブアプリURL*'].includes(name)), false);
});

test('initSheets renames legacy un-starred required labels without touching values', () => {
  const f = fixture({ settings: [
    ['項目', '値', '説明'], ['合言葉', 'existing-token', ''], ['転送先アドレス', 'a@example.invalid', ''],
  ] });
  f.app.initSheets();
  assert.equal(f.sheets.settings.data[0][0], '項目（* は必須）');
  assert.equal(f.sheets.settings.data[settingRow(f, '合言葉')][0], '合言葉*');
  assert.equal(f.sheets.settings.data[settingRow(f, '合言葉')][1], 'existing-token');
  assert.equal(f.sheets.settings.data.filter(row => f.app.normalizeSettingName_(row[0]) === '合言葉').length, 1);
  assert.equal(f.sheets.settings.data.filter(row => f.app.normalizeSettingName_(row[0]) === 'ウェブアプリURL').length, 1);
  assert.equal(f.app.loadSettings_().TOKEN, 'existing-token');
});

test('menuSetup initializes before showing the next-step dialog outside the lock', () => {
  const f = fixture(); f.app.menuSetup(); assert.equal(f.sheets.settings.data.length, 10);
  assert.equal(f.calls.alerts.length, 1); assert.equal(f.calls.alerts[0].includes('デプロイ'), true);
});

const VALID_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbx1234567890/exec';
const setWebAppUrl = (f, url) => { f.sheets.settings.data[settingRow(f, 'ウェブアプリURL')][1] = url; };

for (const url of ['', 'https://example.invalid/exec', 'http://script.google.com/macros/s/x/exec',
  'https://script.google.com/macros/s/x/dev', 'https://script.google.com/macros/s/x',
  'https://script.google.com/macros/s/x/exec?x=1']) {
  test('setup-mail menu refuses a missing or invalid web app URL: ' + (url || 'empty'), () => {
    const f = fixture(); f.app.initSheets(); setWebAppUrl(f, url);
    f.app.sendSetupMail_ = () => { throw new Error('must not send'); }; f.app.menuSendSetupMail();
    assert.equal(f.calls.alerts[0].includes('ウェブアプリURL'), true); assert.equal(f.props.SETUP_MAIL_SENT, undefined);
  });
}

test('setup-mail menu guidance covers books still missing the URL row', () => {
  const f = fixture({ settings: [
    ['項目', '値', '説明'], ['合言葉', 'existing-token', ''],
  ] });
  f.app.sendSetupMail_ = () => { throw new Error('must not send'); }; f.app.menuSendSetupMail();
  assert.equal(f.calls.alerts[0].includes('初期設定'), true); assert.equal(f.props.SETUP_MAIL_SENT, undefined);
});

test('initSheets keeps a pasted web app URL across reruns', () => {
  const f = fixture(); f.app.initSheets(); setWebAppUrl(f, VALID_WEB_APP_URL);
  f.app.initSheets();
  assert.equal(f.sheets.settings.data[settingRow(f, 'ウェブアプリURL')][1], VALID_WEB_APP_URL);
  assert.equal(f.app.loadSettings_().WEB_APP_URL, VALID_WEB_APP_URL);
});

test('setup-mail menu refuses an uninitialized token', () => {
  const f = fixture();
  f.app.sendSetupMail_ = () => { throw new Error('must not send'); }; f.app.menuSendSetupMail();
  assert.equal(f.calls.alerts[0].includes('初期設定'), true);
});

test('setup-mail menu sends the pasted URL to the owner without touching ScriptApp', () => {
  const f = fixture(); f.app.initSheets(); setWebAppUrl(f, VALID_WEB_APP_URL);
  f.sheets.settings.data[settingRow(f, '転送先アドレス')][1] = 'receiver@example.invalid';
  f.props.SETUP_MAIL_SENT = 'old';
  let sent; f.app.sendSetupMail_ = (...args) => { sent = args; }; f.app.menuSendSetupMail();
  assert.deepEqual(sent, ['owner@example.invalid', f.sheets.settings.data[settingRow(f, '合言葉')][1], VALID_WEB_APP_URL]);
  assert.notEqual(f.props.SETUP_MAIL_SENT, 'old'); assert.equal(f.calls.alerts[0].includes('送りました'), true);
  assert.equal(f.calls.alerts[0].includes('@'), false);
});

test('setup-mail menu does not change the sent flag on send failure', () => {
  const f = fixture(); f.app.initSheets(); setWebAppUrl(f, VALID_WEB_APP_URL); f.props.SETUP_MAIL_SENT = 'old';
  f.app.sendSetupMail_ = () => { throw new Error('send failed'); };
  assert.throws(() => f.app.menuSendSetupMail(), /send failed/); assert.equal(f.props.SETUP_MAIL_SENT, 'old'); assert.equal(f.calls.alerts.length, 0);
});

test('menuSetup dialog shows the code version and the URL paste step', () => {
  const f = fixture(); f.app.menuSetup();
  assert.equal(f.calls.alerts[0].includes(f.app.VERSION), true);
  assert.equal(f.calls.alerts[0].includes('ウェブアプリURL'), true);
});

for (const pass of [true, false]) {
  test('test-send menu reports the actual filter outcome: ' + pass, () => {
    const f = fixture(); f.app.testSend = () => ({ pass, reason: pass ? 'no allow rules' : 'deny matched' }); f.app.menuTestSend();
    assert.equal(f.calls.alerts[0].includes(pass ? '送りました' : 'フィルター'), true);
  });
  test('testSend returns the verdict while preserving send and log behavior: ' + pass, () => {
    const f = fixture(); f.app.initSheets();
    if (!pass) f.sheets.filter.data.push(['deny', 'body', 'テスト', 'active']);
    let sent = 0; let logged;
    f.app.sendMail_ = () => { sent++; }; f.app.appendLog_ = (sms, mailed) => { logged = [sms.from, mailed]; };
    const verdict = f.app.testSend(); assert.equal(verdict.pass, pass); assert.equal(sent, pass ? 1 : 0); assert.deepEqual(logged, ['0000', pass]);
  });
}

test('menu handlers refuse to run without a bound spreadsheet UI', () => {
  const f = fixture(); f.app.SpreadsheetApp.getUi = () => { throw new Error('no UI'); };
  for (const handler of ['menuSetup', 'menuSendSetupMail', 'menuTestSend']) assert.throws(() => f.app[handler](), /no UI/);
  assert.equal(f.calls.writes, 0);
});

test('sheet specifications document non-destructive initialization and the managed schemas', () => {
  const spec = fs.readFileSync(path.join(gasDir, '..', 'docs', 'SHEETS_SPEC.md'), 'utf8');
  for (const phrase of ['settings', 'log', 'filter', 'type空欄の例は無効', 'ヘッダー不一致では変更前に停止', '既存値とログは上書き・削除しない', 'ウェブアプリURL', 'バージョン']) assert.equal(spec.includes(phrase), true);
});

test('operations document describes the three menu items and their authorization', () => {
  const operations = fs.readFileSync(path.join(gasDir, '..', 'docs', 'OPERATIONS.md'), 'utf8');
  for (const phrase of ['初期設定', 'スマホの設定手順をメールで送る', 'テスト送信', 'script.container.ui', '端末側の合言葉も更新', 'ウェブアプリURL', '貼り付け']) assert.equal(operations.includes(phrase), true);
  assert.equal(fs.existsSync(path.join(gasDir, '..', 'docs', 'RELEASE_BACKLOG.md')), false);
});

test('doPost rejects a missing log sheet before sending without recreating it', () => {
  const f = fixture(); f.app.initSheets(); delete f.sheets.log;
  let sends = 0; f.app.sendMail_ = () => { sends++; }; f.app.json_ = value => value;
  f.app.CacheService = { getScriptCache: () => ({ get: () => null, put() {} }) };
  Object.assign(f.app.Utilities, { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: () => [], base64EncodeWebSafe: () => 'isolated-key' });
  const result = f.app.doPost({ postData: { contents: JSON.stringify({ token: f.sheets.settings.data[settingRow(f, '合言葉')][1], from: '0000', body: 'test', received_at: 'fixture-date' }) } });
  assert.equal(result.ok, false); assert.equal(sends, 0); assert.equal(f.sheets.log, undefined); assert.equal(f.held, false);
});

test('testSend checks the log destination before sending', () => {
  const f = fixture(); f.app.initSheets(); delete f.sheets.log;
  let sends = 0; f.app.sendMail_ = () => { sends++; };
  assert.throws(() => f.app.testSend(), /初期設定/); assert.equal(sends, 0); assert.equal(f.sheets.log, undefined);
});
