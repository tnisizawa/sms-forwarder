/** @OnlyCurrentDoc */

/**
 * SMS Forwarder 受け口（GAS Web アプリ）
 *
 * Android 端末（SmsForwarder）から POST された SMS を
 *   1. スプレッドシート「log」に記録
 *   2. フィルター（「filter」シート）を通過したら Gmail で自分宛に送信
 * する。
 *
 * 設定は settings シート。旧スクリプトプロパティは初回 setup 時に移行する。
 *
 * POST body (JSON または form):
 *   { token, device, sim, from, body, received_at }
 *   sim は SmsForwarder の [card_slot]（例 "SIM1_a"）。備考部分だけをラベルに使う
 */

var SHEET_LOG = 'log';
var SHEET_FILTER = 'filter';
var SHEET_SETTINGS = 'settings';
var LOG_HEADERS = [
  'logged_at', 'received_at', 'device', 'from', 'body', 'mailed', 'reason', 'sim',
];

function doPost(e) {
  labelCache_ = null;
  var result;
  var authenticated = false;
  var settings;
  var lock;
  var lockHeld = false;
  var mailed = false;
  var sms = { receivedAt: '', loggedAt: new Date(), device: '', sim: '', from: '', body: '' };
  try {
    settings = loadSettings_();
    var data = parseRequest_(e);
    var token = settings.TOKEN;
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
      if (settings.LOG_UNAUTHORIZED === 'yes') {
        appendLog_({ loggedAt: sms.loggedAt, receivedAt: '', device: '', sim: '', from: '', body: '' }, false, 'unauthorized', settings);
      }
      return json_({ ok: false, error: 'unauthorized' });
    }
    authenticated = true;
    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    lockHeld = true;

    // Missing configuration is detected before send; post-send logging failures still degrade safely.
    getSheet_(SHEET_LOG);
    var verdict = judge_(sms, loadRules_());
    if (verdict.pass) {
      var cache = CacheService.getScriptCache();
      var key = 'sms-v1-' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256, duplicateFingerprint_(sms), Utilities.Charset.UTF_8));
      if (cache.get(key)) verdict.reason = 'duplicate';
      else {
        sendMail_(sms, settings);
        mailed = true;
        try { cache.put(key, 'sent', 600); }
        catch (_) { console.warn('[doPost] cache recording failed after send'); }
      }
    }
    try { appendLog_(sms, mailed, verdict.reason, settings, true); }
    catch (logError) {
      if (!mailed && verdict.reason !== 'duplicate') throw logError;
      console.warn('[doPost] log recording failed after success');
    }
    result = { ok: true, mailed: mailed, reason: verdict.reason };
  } catch (err) {
    console.error(err);
    try {
      if (authenticated && lockHeld) appendLog_(sms, false, 'error: processing failed', settings, true);
    } catch (_) {}
    result = { ok: false, error: String(err) };
  } finally {
    if (lockHeld) {
      try { SpreadsheetApp.flush(); }
      catch (_) { console.warn('[doPost] sheet flush failed'); }
      finally { lock.releaseLock(); }
    }
  }
  return json_(result);
}

/**
 * 公開 URL（/exec）をブラウザで開いたときの処理。
 *   - 初回（または ?resend=1）: スマホ用の手順メールを自分宛に送る（ここで取れる URL が正しい /exec）
 *   - 2 回目以降: 生存確認だけ返す
 */
function doGet(e) {
  labelCache_ = null;
  var props = PropertiesService.getScriptProperties();
  var settings = loadSettings_();
  var token = settings.TOKEN;
  if (!token) {
    return html_('<p>まだ準備ができていません。GAS エディタで <b>setup</b> を実行してから、もう一度この URL を開いてください。</p>');
  }
  var resend = e && e.parameter && e.parameter.resend;
  if (!props.getProperty('SETUP_MAIL_SENT') || resend) {
    var mailTo = settings.MAIL_TO || Session.getEffectiveUser().getEmail();
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
  var sheet = getSheet_(SHEET_FILTER);
  return parseRuleRows_(sheet.getDataRange().getValues());
}

function sendMail_(sms, settings) {
  var recipient = settings.MAIL_TO || Session.getEffectiveUser().getEmail();
  // 件名は送信元だけ。同じ番号からのメールが Gmail で 1 スレッドにまとまる
  var subject = '[SMS] ' + sms.from;
  var lines = [
    '送信元: ' + sms.from,
    '端末  : ' + sms.device,
    'SIM   : ' + sms.sim,
    '受信  : ' + sms.receivedAt,
    '',
    sms.body,
  ];
  var props = PropertiesService.getScriptProperties();
  var anchorFrom = String(sms.from).replace(/[^A-Za-z0-9]/g, '_');
  var threadId = props.getProperty('MAIL_THREAD_' + anchorFrom);
  var anchorId = props.getProperty('MAIL_MSG_' + anchorFrom);
  var mime = buildTextMime_(recipient, subject, lines.join('\n'), encodeBase64_,
    anchorId ? { inReplyTo: anchorId, references: anchorId } : null);
  var request = { raw: encodeRaw_(mime) };
  if (threadId) request.threadId = threadId;
  var sent;
  try {
    sent = Gmail.Users.Messages.send(request, 'me');
  } catch (err) {
    if (!threadId) throw err;
    delete request.threadId;
    sent = Gmail.Users.Messages.send(request, 'me');
  }
  updateMailAnchor_(sent, props, anchorFrom);
  var labelName = resolveLabelName_(sms, settings);
  if (labelName) {
    try {
      addLabel_(sent.id, labelName);
    } catch (err) {
      // 送信済みメールを端末側に再送させないため、ラベル失敗は送信失敗にしない。
      console.warn('label failed: ' + String(err));
    }
  }
}

// 送信したメールの threadId と Message-Id を送信元ごとに保存し、同じ番号からの次の送信を同じスレッドへつなげる。
function updateMailAnchor_(sent, props, anchorFrom) {
  try {
    if (sent.threadId) props.setProperty('MAIL_THREAD_' + anchorFrom, sent.threadId);
    var meta = Gmail.Users.Messages.get('me', sent.id, {
      format: 'metadata', metadataHeaders: ['Message-Id'],
    });
    var headers = (meta.payload && meta.payload.headers) || [];
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i].name).toLowerCase() === 'message-id') {
        props.setProperty('MAIL_MSG_' + anchorFrom, headers[i].value);
        break;
      }
    }
  } catch (err) {
    // スレッド継続はあくまで補助。失敗しても送信自体は成功のままにする
    console.warn('thread anchor failed: ' + String(err));
  }
}

function encodeBase64_(value) {
  return Utilities.base64Encode(String(value), Utilities.Charset.UTF_8);
}

function encodeRaw_(mime) {
  return Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8);
}

var labelCache_ = null;

function addLabel_(messageId, labelName) {
  var resolvedLabel = ensureLabel_(labelName);
  Gmail.Users.Messages.modify({ addLabelIds: [resolvedLabel.id] }, 'me', messageId);
}

// 入れ子ラベル（SMS/main 等）は親が存在しないと Gmail でネスト表示されないため、親から順に作る。
function ensureLabel_(labelName) {
  var resolvedLabel = findLabel_(labelName);
  if (!resolvedLabel) {
    var slash = labelName.lastIndexOf('/');
    if (slash > 0) ensureLabel_(labelName.slice(0, slash));
    try {
      resolvedLabel = Gmail.Users.Labels.create({
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      }, 'me');
      labelCache_[labelName] = resolvedLabel;
    } catch (err) {
      // 同時実行が先に作成した場合だけ、そのラベルを取得して続行する。
      resolvedLabel = findLabel_(labelName, true);
      if (!resolvedLabel) throw err;
    }
  }
  return resolvedLabel;
}

function findLabel_(labelName, refresh) {
  if (!labelCache_ || refresh) {
    var labels = Gmail.Users.Labels.list('me').labels || [];
    labelCache_ = Object.create(null);
    for (var i = 0; i < labels.length; i++) labelCache_[labels[i].name] = labels[i];
  }
  return labelCache_[labelName] || null;
}

function appendLog_(sms, mailed, reason, settings, lockHeld) {
  var lock;
  if (!lockHeld) {
    lock = LockService.getScriptLock();
    lock.waitLock(30000);
  }
  try {
    var sheet = getSheet_(SHEET_LOG);
    // 先頭の ' で電話番号を文字列として保存（0000 が 0 に化けるのを防ぐ）
    sheet.appendRow([
      sms.loggedAt, sms.receivedAt, sms.device, "'" + sms.from, sms.body,
      mailed ? 'yes' : 'no', reason, sms.sim,
    ]);
    var maxRows = resolveLogMaxRows_((settings || loadSettings_()).LOG_MAX_ROWS);
    var excess = logExcessRows_(sheet.getLastRow(), maxRows);
    if (excess) sheet.deleteRows(2, excess);
  } finally {
    if (lock) {
      try { SpreadsheetApp.flush(); }
      finally { lock.releaseLock(); }
    }
  }
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('必要なシートがありません。SMS転送メニューの初期設定を実行してください。');
  return sheet;
}

// 4列目の true は必須項目。必須は表示名の末尾に * を付け、ヘッダーで凡例を示す
var SETTINGS_HEADER_ = ['項目（* は必須）', '値', '説明'];
var SETTINGS_HEADER_LEGACY_ = ['項目', '値', '説明'];
var SETTINGS_ROWS_ = [
  ['合言葉', '', 'スマホと共有する合言葉。消して setup を実行すると作り直されます', true],
  ['転送先アドレス', '', '空なら自分宛に送ります'],
  ['ラベルの付け方', 'SIM名', 'SIM名 / 端末名 / 固定名 / 付けない'],
  ['固定ラベル名', '', '「固定名」のときに使います'],
  ['親ラベル', 'SMS', 'この下にまとめます。空なら親ラベルを付けません'],
  ['ログの保持行数', 1000, 'ヘッダーを除く保持件数。超過分は古い行から自動削除。空欄・不正値は1000行'],
  ['未認証も記録する', 'いいえ', '切り分け時だけ「はい」にします'],
  ['ウェブアプリURL', '', 'ウェブアプリをデプロイ後、公開画面のURL（/execで終わる）を貼り付けます', true]
];

function loadSettings_() {
  var defaults = {
    TOKEN: '', MAIL_TO: '', LABEL_MODE: 'sim', LABEL_NAME: '', LABEL_PREFIX: 'SMS',
    LOG_MAX_ROWS: 1000, LOG_UNAUTHORIZED: 'no', WEB_APP_URL: ''
  };
  var props = null;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  var sheetValues = sheet ? parseSettingsRows_(sheet.getDataRange().getValues()) : {};
  Object.keys(defaults).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(sheetValues, key)) defaults[key] = sheetValues[key];
    else if (key !== 'WEB_APP_URL') {
      // ウェブアプリURLはシートの明示入力だけを使う（旧プロパティや自動取得へ倒さない）
      if (!props) props = PropertiesService.getScriptProperties().getProperties();
      if (Object.prototype.hasOwnProperty.call(props, key)) defaults[key] = props[key];
    }
  });
  return defaults;
}

/** 先頭のデータ行にコードの版を出す。利用者の値ではないため毎回 VERSION で更新する */
function ensureVersionRow_(sheet) {
  var row = 0;
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var items = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < items.length; i++) {
      if (String(items[i][0]).trim() === 'バージョン') { row = i + 2; break; }
    }
  }
  if (!row) {
    sheet.insertRowBefore(2);
    row = 2;
    sheet.getRange(row, 1, 1, 3).setValues([['バージョン', '', 'コードの版です。コード更新で変わります']]);
  }
  sheet.getRange(row, 2).setValue(VERSION);
}

function ensureSettingsSheet_() {
  var sheet = getSheet_(SHEET_SETTINGS);
  // 凡例なしの旧ヘッダーは新表記へ移行する
  if (String(sheet.getRange(1, 1).getValue()).trim() === SETTINGS_HEADER_LEGACY_[0]) {
    sheet.getRange(1, 1).setValue(SETTINGS_HEADER_[0]);
  }
  ensureVersionRow_(sheet);
  var props = PropertiesService.getScriptProperties();
  var old = props.getProperties();
  var existing = {};
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var label = String(values[i][0] || '').trim();
    if (label) existing[normalizeSettingName_(label)] = { row: i + 1, label: label };
  }

  // 星なし旧表記の行はすべて新表記へ揃える（値・説明は触らない）
  var displays = {};
  SETTINGS_ROWS_.forEach(function (d) { displays[d[0]] = d[0] + (d[3] ? '*' : ''); });
  for (var j = 1; j < values.length; j++) {
    var want = displays[normalizeSettingName_(values[j][0])];
    var raw = String(values[j][0] || '').trim();
    if (want && raw !== want) sheet.getRange(j + 1, 1).setValue(want);
  }

  var token = resolveSetupToken_(values, old.TOKEN, function () {
    return Utilities.getUuid().replace(/-/g, '');
  });
  var initial = {
    '合言葉': token,
    '転送先アドレス': old.MAIL_TO || '',
    'ラベルの付け方': { sim: 'SIM名', device: '端末名', fixed: '固定名', none: '付けない' }[
      String(old.LABEL_MODE || 'sim').trim().toLowerCase()
    ] || 'SIM名'
  };
  SETTINGS_ROWS_.forEach(function (definition) {
    var item = definition[0];
    var display = item + (definition[3] ? '*' : '');
    var hit = existing[item];
    if (!hit) {
      sheet.appendRow([display, Object.prototype.hasOwnProperty.call(initial, item) ? initial[item] : definition[1], definition[2]]);
      return;
    }
    if (item === '合言葉' && !sheet.getRange(hit.row, 2).getValue()) {
      sheet.getRange(hit.row, 2).setValue(token);
    }
  });
  sheet.setFrozenRows(1);
  applySettingsRules_(sheet);

  var migrated = parseSettingsRows_(sheet.getDataRange().getValues());
  if (migrated.TOKEN && Object.prototype.hasOwnProperty.call(migrated, 'MAIL_TO') && migrated.LABEL_MODE) {
    props.deleteProperty('TOKEN');
    props.deleteProperty('MAIL_TO');
    props.deleteProperty('LABEL_MODE');
  }
  return sheet;
}

function applySettingsRules_(sheet) {
  var values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var item = normalizeSettingName_(values[i][0]);
    if (item === 'ラベルの付け方') {
      sheet.getRange(i + 2, 2).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(['SIM名', '端末名', '固定名', '付けない'], true).setAllowInvalid(false).build());
    }
    if (item === '未認証も記録する') {
      sheet.getRange(i + 2, 2).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(['はい', 'いいえ'], true).setAllowInvalid(false).build());
    }
  }
  ensureWarningProtection_(sheet, sheet.getRange('A:A'), 'settings-items');
  ensureWarningProtection_(sheet, sheet.getRange('C:C'), 'settings-descriptions');
}

function ensureWarningProtection_(sheet, range, description) {
  var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var i = 0; i < protections.length; i++) {
    if (protections[i].getDescription() === description) return;
  }
  range.protect().setDescription(description).setWarningOnly(true);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

var APK_RELEASES_URL = 'https://github.com/pppscn/SmsForwarder/releases';

/**
 * 初期設定の互換入口。不足シート・設定を非破壊で補完し、再実行できる。
 * 手順メールはデプロイ後にメニューから送る（従来のdoGetによる送信も維持）。
 */
function setup() {
  labelCache_ = null;
  initSheets();
  Logger.log('準備完了（バージョン ' + VERSION + '）。ウェブアプリをデプロイし、表示されたURLをsettingsの「ウェブアプリURL」へ貼り付けてから、SMS転送メニューで手順メールを送れます。');
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
    h.push('<p style="color:#b00"><b>注意:</b> ウェブアプリの URL が取れませんでした。初回はウェブアプリ（実行ユーザー: 自分 / アクセス: 全員）をデプロイし、公開 URL を開いてください。更新時は既存デプロイを新バージョンへ更新してください。</p>');
  }
  h.push('<h3>1. アプリを入れる</h3>');
  h.push('<p><a href="' + APK_RELEASES_URL + '">SmsForwarder の配布ページ</a> を開き、一番上の Assets から <b>SmsForwarder_x.x.x_universal.apk</b> をダウンロードしてインストール（「提供元不明のアプリ」の許可が出たら許可）。</p>');
  h.push('<h3>2. 英語に切り替える（初回起動は中国語で出ます）</h3>');
  h.push('<ol>' +
    '<li>起動すると中国語の確認画面が出ます。「<b>同意</b>」（同意する）を押す</li>' +
    '<li>ヒントのカルーセルが出たら「下一条」（次へ）を最後まで進めるか「✗」で閉じる</li>' +
    '<li>画面下のバーの右端「<b>通用设置</b>」（SETTINGS）を開く</li>' +
    '<li>下までスクロールして「<b>多语言设置</b>」→「<b>English</b>」を選ぶ</li></ol>' +
    '<p>以降このメールの画面名は英語表記で書きます。</p>');
  h.push('<h3>3. 権限と端末名</h3>');
  h.push('<ol>' +
    '<li>「SETTINGS」タブの「<b>Forward Sms</b>」を ON にし、求められた権限を許可（SMS・電話。電話が無いと SIM 名が取れずラベルが付きません）' +
    '<ul><li>「通知へのアクセス」は他アプリの通知転送用なので SMS だけなら不要</li>' +
    '<li>Android 13 以降で「制限付き設定」と出たら: 設定 → アプリ → SmsForwarder → 右上「⋮」→「制限付き設定を許可」</li></ul></li>' +
    '<li>同じ画面を下へスクロールし、「<b>Device Name</b>」に端末名（例: phone1）、「<b>SIM1 SubId/Label</b>」に SIM の名前（例: main）を入れる。この名前が Gmail のラベル名になります</li>' +
    '<li>電池の最適化の除外と自動起動を許可（端末の設定側。止まるときの原因として多い）</li></ol>');
  h.push('<h3>4. 送り先（Sender）を作る</h3>');
  h.push('<p>「SENDERS」タブ → 右上「+」→「<b>Webhook</b>」を選び、次の通りに入力します（長押しでコピーできます）。</p>');
  h.push('<p>名前</p>' + box('gas-sms'));
  h.push('<p>Method</p>' + box('POST'));
  h.push('<p>Webhook server（URL）</p>' + box(deployed ? url : '（デプロイ後に公開 URL を開いてください）'));
  h.push('<p>Web params（1 行そのまま貼る）</p>' + box(webParams));
  h.push('<p>Secret は空のまま。「<b>Test</b>」を押すと実 SMS を待たずに GAS への疎通を確認できます（スプレッドシートの log シートに1行増えます）。できたら「<b>Save</b>」。</p>');
  h.push('<h3>5. 転送ルール（Rule）を作る</h3>');
  h.push('<p>「RULES」タブ → 右上「+」。「Select Sender」にさっき作った Sender、「Field」は「All」、「SIM Slot」は「<b>Any SIM</b>」のまま（両 SIM が対象。片方だけに変えるともう一方の SMS が転送されません）、「Enable This Forwarding Rule」を ON にして「Save」。</p>');
  h.push('<h3>6. 確認</h3>');
  h.push('<p>別の電話から SMS を 1 通送り、<b>[SMS] 番号</b> という件名のメールが届けば完了です。届かないときはスプレッドシートの <b>log</b> シートに理由が残ります。</p>');
  h.push('<hr><p style="font-size:13px;color:#666">転送ルールは <b>filter</b> シート、宛先・ラベル・合言葉は <b>settings</b> シートで変更できます。合言葉を作り直すときは値を消して setup を再実行してください。</p>');
  h.push('</div>');

  var plain = [
    '1. ' + APK_RELEASES_URL + ' から universal.apk を入れる',
    '2. 英語に切り替える（初回は中国語）: 同意 → 下のバー右端「通用设置」→ 下までスクロール「多语言设置」→ English',
    '3. SETTINGS タブ: Forward Sms を ON → 権限を許可（SMS・電話。通知アクセスは不要）',
    '   同画面の下部: Device Name に端末名、SIM1 SubId/Label に SIM 名（ラベル名になる）',
    '   電池最適化の除外・自動起動も許可',
    '4. SENDERS → + → Webhook',
    '   名前: gas-sms',
    '   Method: POST',
    '   Webhook server: ' + (deployed ? url : '（デプロイ後に公開 URL を開く）'),
    '   Web params: ' + webParams,
    '   Secret は空。Test で疎通確認 → Save',
    '5. RULES → + → Select Sender=gas-sms / Field=All / SIM Slot=Any SIM / Enable ON → Save',
    '6. SMS を 1 通送って届けば完了（件名 [SMS] 番号。同じ番号は1スレッドにまとまる）',
  ].join('\n');

  var boundary = 'sms-forwarder-' + Utilities.getUuid().replace(/-/g, '');
  var mime = buildMultipartMime_(to, '[SMS転送] スマホ側の設定手順（トークン入り）',
    plain, h.join('\n'), boundary, encodeBase64_);
  Gmail.Users.Messages.send({ raw: encodeRaw_(mime) }, 'me');
}

/**
 * 送信テスト（GAS エディタから手で実行）
 */
function testSend() {
  labelCache_ = null;
  var settings = loadSettings_();
  getSheet_(SHEET_LOG);
  var sms = {
    receivedAt: new Date().toISOString(),
    loggedAt: new Date(),
    device: '1',
    sim: simName_('SIM1_t'),
    from: '0000',
    body: 'これはテストです',
  };
  var verdict = judge_(sms, loadRules_());
  if (verdict.pass) sendMail_(sms, settings);
  appendLog_(sms, verdict.pass, verdict.reason, settings);
  Logger.log(JSON.stringify(verdict));
  return verdict;
}
