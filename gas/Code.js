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
 *   LABEL_MODE: Gmail ラベルの付け方 sim（既定）| device | none
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

    var verdict = judge_(sms, loadRules_());
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

/**
 * 公開 URL（/exec）をブラウザで開いたときの処理。
 *   - 初回（または ?resend=1）: スマホ用の手順メールを自分宛に送る（ここで取れる URL が正しい /exec）
 *   - 2 回目以降: 生存確認だけ返す
 */
function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  if (!token) {
    return html_('<p>まだ準備ができていません。GAS エディタで <b>setup</b> を実行してから、もう一度この URL を開いてください。</p>');
  }
  var resend = e && e.parameter && e.parameter.resend;
  if (!props.getProperty('SETUP_MAIL_SENT') || resend) {
    var mailTo = props.getProperty('MAIL_TO') || Session.getEffectiveUser().getEmail();
    sendSetupMail_(mailTo, token, ScriptApp.getService().getUrl());
    props.setProperty('SETUP_MAIL_SENT', new Date().toISOString());
    return html_('<p>スマホ側の設定手順を <b>' + mailTo + '</b> に送りました。スマホでそのメールを開いて進めてください。</p>' +
      '<p style="color:#666;font-size:13px">もう一度送りたいときは、この URL の末尾に <code>?resend=1</code> を付けて開いてください。</p>');
  }
  return json_({ ok: true, service: 'sms-forwarder' });
}

function html_(body) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:16px;line-height:1.7;padding:16px">' + body + '</div>');
}

/**
 * filter シートに基づく判定。
 *   列: type (allow|deny) / field (from|body|device|sim) / pattern (正規表現) / memo
 *   - deny に一致したら不合格
 *   - allow 行が 1 つも無ければ全通し、あれば allow に一致したものだけ合格
 */
function loadRules_() {
  var sheet = getSheet_(SHEET_FILTER, ['type', 'field', 'pattern', 'memo']);
  return parseRuleRows_(sheet.getDataRange().getValues());
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
  var labelName = labelFor_(sms);
  if (labelName) labelLatest_(subject, [labelName]);
}

/**
 * スクリプトプロパティ LABEL_MODE で Gmail ラベルの付け方を選ぶ
 *   sim    : SIM のニックネーム（既定）
 *   device : 端末名
 *   none   : ラベルを付けない
 */
function labelFor_(sms) {
  var mode = String(PropertiesService.getScriptProperties().getProperty('LABEL_MODE') || 'sim')
    .trim().toLowerCase();
  if (mode === 'none') return '';
  if (mode === 'device') return sms.device || '';
  return sms.sim || '';
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

var APK_RELEASES_URL = 'https://github.com/pppscn/SmsForwarder/releases';

/**
 * 初期セットアップ（GAS エディタから 1 回だけ手で実行する）
 *   - log / filter シートを作る
 *   - TOKEN が未設定ならランダム生成
 *   - 権限承認ダイアログを出す
 *   - スマホ用の手順メールは、デプロイ後に公開 URL を開いたとき doGet が送る
 */
function setup() {
  getSheet_(SHEET_LOG, LOG_HEADERS);
  getSheet_(SHEET_FILTER, ['type', 'field', 'pattern', 'memo']);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  var token = props.getProperty('TOKEN');
  var mailTo = props.getProperty('MAIL_TO') || Session.getEffectiveUser().getEmail();
  Logger.log('TOKEN = ' + token);
  Logger.log('MAIL_TO = ' + mailTo);
  Logger.log('準備完了。次に「デプロイ」→「新しいデプロイ」→「ウェブアプリ」で公開し、表示された URL をブラウザで開くと、' +
    mailTo + ' にスマホ用の手順メールが届きます。');
}

/**
 * スマホ側の設定手順メール。SmsForwarder に貼る値は全部埋めた状態で送る
 */
function sendSetupMail_(to, token, url) {
  var deployed = url && /\/exec$/.test(url);
  var webParams = 'token=' + token +
    '&device=[device_mark]&sim=[card_slot]&from=[from]&body=[org_content]&received_at=[receive_time]';
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var box = function (s) {
    return '<pre style="background:#f3f3f3;padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:14px">' + esc(s) + '</pre>';
  };
  var h = [];
  h.push('<div style="font-family:sans-serif;font-size:15px;line-height:1.7">');
  h.push('<p>SMS 転送の受け口（GAS）の準備ができました。このメールをスマホで開いて、上から順に進めてください。</p>');
  if (!deployed) {
    h.push('<p style="color:#b00"><b>注意:</b> ウェブアプリの URL が取れませんでした。GAS エディタで「デプロイ」→「新しいデプロイ」→「ウェブアプリ」（実行ユーザー: 自分 / アクセス: 全員）を済ませてから、もう一度 <code>setup</code> を実行してください。</p>');
  }
  h.push('<h3>1. アプリを入れる</h3>');
  h.push('<p><a href="' + APK_RELEASES_URL + '">SmsForwarder の配布ページ</a> を開き、一番上の Assets から <b>SmsForwarder_x.x.x_universal.apk</b> をダウンロードしてインストール（「提供元不明のアプリ」の許可が出たら許可）。</p>');
  h.push('<h3>2. 権限を許可する</h3>');
  h.push('<ul><li>SMS / 電話 / 通知の表示 → 許可</li>' +
    '<li>「通知へのアクセス」は不要（スキップしてよい）</li>' +
    '<li>Android 13 以降で「制限付き設定」と出たら: 設定 → アプリ → SmsForwarder → 右上「⋮」→「制限付き設定を許可」→ もう一度権限を許可</li>' +
    '<li>アプリ内の設定で「電池の最適化を無視」と「自動起動」を ON</li></ul>');
  h.push('<h3>3. 端末名と SIM の名前を付ける</h3>');
  h.push('<p>General settings → <b>Device mark</b> に端末を区別する名前（例: A）。SIM が複数あるなら <b>SIM1 / SIM2 の備考</b> に短い名前（例: a, b）。SIM の名前がそのまま Gmail のラベルになります。</p>');
  h.push('<h3>4. 送信先（Sender）を作る</h3>');
  h.push('<p>Sender → 「+」→ <b>Webhook</b>。次の通りに入力（長押しでコピーできます）。</p>');
  h.push('<p>名前</p>' + box('gas-sms'));
  h.push('<p>Method</p>' + box('POST'));
  h.push('<p>Webhook server（URL）</p>' + box(deployed ? url : '（デプロイ後に setup を再実行してください）'));
  h.push('<p>Web params（1 行そのまま貼る）</p>' + box(webParams));
  h.push('<p>Secret は空のまま。保存して「Test」を押すと、このメールアドレスにテストメールが届きます。</p>');
  h.push('<h3>5. 転送ルール（Rule）を作る</h3>');
  h.push('<p>Rule → SMS → 「+」。条件は「All」、Sender は gas-sms、SIM は両方。保存してトグルを ON。</p>');
  h.push('<h3>6. 確認</h3>');
  h.push('<p>別の電話から SMS を 1 通送り、<b>[SMS] 番号</b> という件名のメールが届けば完了です。届かないときはスプレッドシートの <b>log</b> シートに理由が残ります。</p>');
  h.push('<hr><p style="font-size:13px;color:#666">転送ルールの調整は <b>filter</b> シートで（type: allow / deny、field: from / body / device / sim、pattern: 正規表現）。Gmail のラベルは既定で SIM の名前が付きます。要らなければスクリプトプロパティ <b>LABEL_MODE</b> を <b>none</b>（端末名にするなら <b>device</b>）にしてください。TOKEN を変えたいときはスクリプトプロパティを消して setup を再実行。</p>');
  h.push('</div>');

  var plain = [
    '1. ' + APK_RELEASES_URL + ' から APK を入れる',
    '2. 権限: SMS / 電話 / 通知の表示 を許可。電池最適化の無視と自動起動を ON',
    '3. General settings: Device mark と SIM の備考に名前',
    '4. Sender → + → Webhook',
    '   名前: gas-sms',
    '   Method: POST',
    '   URL: ' + (deployed ? url : '（デプロイ後に setup を再実行）'),
    '   Web params: ' + webParams,
    '5. Rule → SMS → +（All / gas-sms / SIM 両方）→ ON',
    '6. SMS を 1 通送って届けば完了',
  ].join('\n');

  GmailApp.sendEmail(to, '[SMS転送] スマホ側の設定手順（トークン入り）', plain, { htmlBody: h.join('\n') });
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
  var verdict = judge_(sms, loadRules_());
  if (verdict.pass) sendMail_(sms, PropertiesService.getScriptProperties().getProperty('MAIL_TO'));
  appendLog_(sms, verdict.pass, verdict.reason);
  Logger.log(JSON.stringify(verdict));
}
