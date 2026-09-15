/**
 * SMS Forwarder 受け口（GAS Web アプリ）
 *
 * Android 端末（MacroDroid）から POST された SMS を
 *   1. スプレッドシート「log」に記録
 *   2. フィルター（「filter」シート）を通過したら Gmail で自分宛に送信
 * する。
 *
 * 設定はスクリプトプロパティ:
 *   TOKEN     : 端末側と共有する合言葉（必須）
 *   MAIL_TO   : 転送先メールアドレス（省略時はスクリプト実行者）
 *
 * POST body (JSON または form):
 *   { token, device, sim, from, body, received_at }
 *   sim は SmsForwarder の [card_slot]（例 "SIM1_a"）。備考部分だけをラベルに使う
 */

var SHEET_LOG = 'log';
var SHEET_FILTER = 'filter';
var LOG_HEADERS = [
  'logged_at', 'received_at', 'device', 'from', 'body', 'mailed', 'reason', 'sim',
];

function doPost(e) {
  var result;
  var sms = { receivedAt: '', loggedAt: new Date(), device: '', sim: '', from: '', body: '' };
  try {
    var data = parseRequest_(e);
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('TOKEN');
    sms.receivedAt = data.received_at || '';
    sms.device = data.device || '';
    sms.from = data.from || '';
    sms.body = data.body || '';
    sms.sim = simName_(data.sim || '');
    if (!sms.sim) {
      // sim パラメータが無い旧設定の端末向け: 本文中の "SIM2_N" 行から拾う
      var m = String(sms.body).match(/^SIM\d[_:]\s*(\S+)\s*$/m);
      if (m) sms.sim = m[1];
    }

    if (!token || data.token !== token) {
      // 切り分け用に、届いたキー一覧だけ残す（値は残さない）
      appendLog_(sms, false, 'unauthorized keys=' + Object.keys(data).join(','));
      return json_({ ok: false, error: 'unauthorized' });
    }

    var verdict = judge_(sms);
    var mailed = false;
    if (verdict.pass) {
      sendMail_(sms, props.getProperty('MAIL_TO'));
      mailed = true;
    }
    appendLog_(sms, mailed, verdict.reason);
    result = { ok: true, mailed: mailed, reason: verdict.reason };
  } catch (err) {
    console.error(err);
    try {
      appendLog_(sms, false, 'error: ' + String(err));
    } catch (_) {}
    result = { ok: false, error: String(err) };
  }
  return json_(result);
}

// 動作確認用（ブラウザで開くと生存確認だけ返す）
function doGet() {
  return json_({ ok: true, service: 'sms-forwarder' });
}

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('empty body');
  }
  var raw = e.postData.contents;
  try {
    return JSON.parse(raw);
  } catch (_) {
    // JSON でなければ form-urlencoded として扱う
    return e.parameter || {};
  }
}

/**
 * filter シートに基づく判定。
 *   列: type (allow|deny) / field (from|body|device|sim) / pattern (正規表現) / memo
 *   - deny に一致したら不合格
 *   - allow 行が 1 つも無ければ全通し、あれば allow に一致したものだけ合格
 */
function judge_(sms) {
  var rules = loadRules_();
  var allows = rules.filter(function (r) { return r.type === 'allow'; });
  var denies = rules.filter(function (r) { return r.type === 'deny'; });

  for (var i = 0; i < denies.length; i++) {
    if (matchRule_(denies[i], sms)) {
      return { pass: false, reason: 'deny:' + denies[i].pattern };
    }
  }
  if (allows.length === 0) {
    return { pass: true, reason: 'no-allow-rules' };
  }
  for (var j = 0; j < allows.length; j++) {
    if (matchRule_(allows[j], sms)) {
      return { pass: true, reason: 'allow:' + allows[j].pattern };
    }
  }
  return { pass: false, reason: 'no-allow-match' };
}

function matchRule_(rule, sms) {
  var target = sms[rule.field];
  if (target === undefined) return false;
  try {
    return new RegExp(rule.pattern, 'i').test(String(target));
  } catch (_) {
    return false;
  }
}

function loadRules_() {
  var sheet = getSheet_(SHEET_FILTER, ['type', 'field', 'pattern', 'memo']);
  var values = sheet.getDataRange().getValues();
  var rules = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var type = String(row[0] || '').trim().toLowerCase();
    var field = String(row[1] || '').trim().toLowerCase();
    var pattern = String(row[2] || '').trim();
    if (!type || !field || !pattern) continue;
    if (type !== 'allow' && type !== 'deny') continue;
    if (['from', 'body', 'device', 'sim'].indexOf(field) < 0) continue;
    rules.push({ type: type, field: field, pattern: pattern });
  }
  return rules;
}

function sendMail_(sms, to) {
  var recipient = to || Session.getEffectiveUser().getEmail();
  // 件名は送信元だけ（同じ番号からのメールが Gmail で 1 スレッドにまとまる）
  var subject = '[SMS] ' + sms.from;
  var lines = [
    '送信元: ' + sms.from,
    '端末  : ' + sms.device,
    'SIM   : ' + sms.sim,
    '受信  : ' + sms.receivedAt,
    '',
    sms.body,
  ];
  GmailApp.sendEmail(recipient, subject, lines.join('\n'));
  // ラベルは SIM のニックネームだけ（端末名は本文に載せるのみ）
  if (sms.sim) labelLatest_(subject, [sms.sim]);
}

/**
 * SmsForwarder の [card_slot]（"SIM1_a" / "SIM2" など）から備考（ニックネーム）だけを取り出す。
 * 備考が無ければ "SIM1" のようにスロット名をそのまま返す。
 */
function simName_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var m = s.match(/^(SIM\s*\d)\s*[_:\-\s]\s*(.+)$/i);
  if (m) return m[2].trim();
  return s;
}

/**
 * 送ったばかりのメールのスレッドにラベルを付ける（無ければ作る）
 */
function labelLatest_(subject, labelNames) {
  var labels = labelNames.map(function (name) {
    return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  });
  for (var i = 0; i < 5; i++) {
    var threads = GmailApp.search('subject:"' + subject + '" newer_than:1d', 0, 1);
    if (threads.length) {
      labels.forEach(function (label) { threads[0].addLabel(label); });
      return;
    }
    Utilities.sleep(1000);
  }
  console.warn('label skipped: thread not found for ' + subject);
}

function appendLog_(sms, mailed, reason) {
  var sheet = getSheet_(SHEET_LOG, LOG_HEADERS);
  if (sheet.getRange(1, 8).getValue() !== 'sim') sheet.getRange(1, 8).setValue('sim');
  // 先頭の ' で電話番号を文字列として保存（0000 が 0 に化けるのを防ぐ）
  sheet.appendRow([
    sms.loggedAt, sms.receivedAt, sms.device, "'" + sms.from, sms.body,
    mailed ? 'yes' : 'no', reason, sms.sim,
  ]);
}

function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 初期セットアップ（GAS エディタから 1 回だけ手で実行する）
 *   - log / filter シートを作る
 *   - TOKEN が未設定ならランダム生成してログに出す
 *   - 権限承認ダイアログを出す
 */
function setup() {
  getSheet_(SHEET_LOG, LOG_HEADERS);
  getSheet_(SHEET_FILTER, ['type', 'field', 'pattern', 'memo']);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('TOKEN = ' + props.getProperty('TOKEN'));
  Logger.log('MAIL_TO = ' + (props.getProperty('MAIL_TO') || Session.getEffectiveUser().getEmail()));
}

/**
 * 送信テスト（GAS エディタから手で実行）
 */
function testSend() {
  var sms = {
    receivedAt: new Date().toISOString(),
    loggedAt: new Date(),
    device: '1',
    sim: simName_('SIM1_t'),
    from: '0000',
    body: 'これはテストです',
  };
  var verdict = judge_(sms);
  if (verdict.pass) sendMail_(sms, PropertiesService.getScriptProperties().getProperty('MAIL_TO'));
  appendLog_(sms, verdict.pass, verdict.reason);
  Logger.log(JSON.stringify(verdict));
}
