/** @OnlyCurrentDoc */

/** Simple trigger: constructing the menu requires no settings or Gmail authorization. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('SMS転送')
    .addItem('初期設定', 'menuSetup')
    .addItem('スマホの設定手順をメールで送る', 'menuSendSetupMail')
    .addItem('テスト送信', 'menuTestSend')
    .addToUi();
}

function menuSetup() {
  var ui = SpreadsheetApp.getUi();
  setup();
  // alert suspends execution, so initialization must release its lock first.
  ui.alert('初期設定が完了しました（バージョン ' + VERSION + '）。ウェブアプリをデプロイし、公開画面に表示されたURLをsettingsの「ウェブアプリURL」へ貼り付けてから、「スマホの設定手順をメールで送る」を実行してください。');
}

function menuSendSetupMail() {
  var ui = SpreadsheetApp.getUi();
  var settings = loadSettings_();
  if (!settings.TOKEN) {
    ui.alert('先に「初期設定」を実行してください。');
    return;
  }
  var url = settings.WEB_APP_URL;
  if (!isWebAppUrl_(url)) {
    ui.alert('ウェブアプリをデプロイし、公開画面に表示されたURL（/execで終わる）をsettingsの「ウェブアプリURL」へ貼り付けてください。「ウェブアプリURL」の行がなければ、先に「初期設定」を実行すると行が追加されます。');
    return;
  }
  sendSetupMail_(Session.getEffectiveUser().getEmail(), settings.TOKEN, url);
  PropertiesService.getScriptProperties().setProperty('SETUP_MAIL_SENT', new Date().toISOString());
  ui.alert('自分宛にスマホの設定手順を送りました。スマホでメールを開いて進めてください。');
}

function menuTestSend() {
  var ui = SpreadsheetApp.getUi();
  var verdict = testSend();
  ui.alert(verdict.pass ? '設定した転送先へテストメールを送りました。logシートも確認してください。' :
    'フィルターによってテストメールは送られませんでした。filterとlogシートを確認してください。');
}

/** Definitions are evaluated at call time so GAS file ordering is irrelevant. */
function sheetSchema_() {
  return [
    { name: SHEET_SETTINGS, headers: ['項目', '値', '説明'], widths: [180, 300, 500] },
    { name: SHEET_LOG, headers: LOG_HEADERS, widths: [170, 170, 120, 150, 420, 80, 180, 120] },
    { name: SHEET_FILTER, headers: ['type', 'field', 'pattern', 'memo'], widths: [100, 120, 300, 350] },
  ];
}

/** Only initialization may create sheets; receiving never repairs the schema. */
function initSheets() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var schema = sheetSchema_();
    // Validate every existing header before creating or modifying anything.
    schema.forEach(function (definition) {
      var sheet = ss.getSheetByName(definition.name);
      if (!sheet || !sheet.getLastRow()) return;
      var header = sheet.getRange(1, 1, 1, definition.headers.length).getValues()[0];
      if (definition.headers.some(function (value, i) { return header[i] !== value; })) {
        throw new Error('ヘッダーが一致しません。シートの構成を確認してください。');
      }
    });
    schema.forEach(function (definition) {
      var sheet = ss.getSheetByName(definition.name);
      if (!sheet) sheet = ss.insertSheet(definition.name);
      if (!sheet.getLastRow()) sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
    });
    ensureSettingsSheet_();
    var filter = getSheet_(SHEET_FILTER);
    if (filter.getLastRow() === 1) {
      // Empty type makes examples inert: users explicitly choose allow/deny to activate them.
      filter.getRange(2, 1, 2, 4).setValues([
        ['', 'from', '^090', '例: この番号で始まる送信元（typeを選ぶと有効）'],
        ['', 'body', '認証', '例: この語を含む本文（typeを選ぶと有効）'],
      ]);
    }
    schema.forEach(function (definition) {
      var sheet = getSheet_(definition.name);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, definition.headers.length).setFontWeight('bold');
      definition.widths.forEach(function (width, i) { sheet.setColumnWidth(i + 1, width); });
    });
    var log = getSheet_(SHEET_LOG);
    var logRows = log.getMaxRows() - 1;
    if (logRows > 0) {
      log.getRange(2, 4, logRows, 1).setNumberFormat('@');
      log.getRange(2, 5, logRows, 1).setWrap(true);
    }
    var filterRows = filter.getMaxRows() - 1;
    if (filterRows > 0) {
      filter.getRange(2, 1, filterRows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(['allow', 'deny'], true).setAllowInvalid(false).build());
      filter.getRange(2, 2, filterRows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(['from', 'body', 'device', 'sim'], true).setAllowInvalid(false).build());
    }
  } finally {
    try { SpreadsheetApp.flush(); }
    finally { lock.releaseLock(); }
  }
}
