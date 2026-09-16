/** コードの版。GitHub の Releases / CHANGELOG.md と突き合わせる */
var VERSION = '1.0.0';

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

function judge_(sms, rules) {
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

function parseRuleRows_(values) {
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

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('empty body');
  }
  var raw = e.postData.contents;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return e.parameter || {};
  }
}

function sanitizeMimeHeader_(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function normalizeCrlf_(value) {
  return String(value || '').replace(/\r\n|\r|\n/g, '\r\n');
}

function encodeMimeSubject_(subject, encodeBase64) {
  return '=?UTF-8?B?' + encodeBase64(sanitizeMimeHeader_(subject)) + '?=';
}

function buildTextMime_(to, subject, body, encodeBase64) {
  return [
    'To: ' + sanitizeMimeHeader_(to),
    'Subject: ' + encodeMimeSubject_(subject, encodeBase64),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeCrlf_(body)
  ].join('\r\n');
}

function buildMultipartMime_(to, subject, plain, html, boundary, encodeBase64) {
  var safeBoundary = sanitizeMimeHeader_(boundary).replace(/["\\]/g, '');
  return [
    'To: ' + sanitizeMimeHeader_(to),
    'Subject: ' + encodeMimeSubject_(subject, encodeBase64),
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + safeBoundary + '"',
    '',
    '--' + safeBoundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeCrlf_(plain),
    '--' + safeBoundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeCrlf_(html),
    '--' + safeBoundary + '--'
  ].join('\r\n');
}

function resolveLabelName_(sms, settings) {
  var mode = String(settings.LABEL_MODE || 'sim').trim().toLowerCase();
  var name = '';
  if (mode === 'sim') name = simName_(sms.sim);
  if (mode === 'device') name = String(sms.device || '').trim();
  if (mode === 'fixed') name = String(settings.LABEL_NAME || '').trim();
  if (!name || mode === 'none') return '';

  var prefix = String(settings.LABEL_PREFIX || '').trim();
  return prefix ? prefix + '/' + name : name;
}

var SETTING_KEYS_ = {
  '合言葉': 'TOKEN',
  '転送先アドレス': 'MAIL_TO',
  'ラベルの付け方': 'LABEL_MODE',
  '固定ラベル名': 'LABEL_NAME',
  '親ラベル': 'LABEL_PREFIX',
  'ログの保持行数': 'LOG_MAX_ROWS',
  '未認証も記録する': 'LOG_UNAUTHORIZED',
  'ウェブアプリURL': 'WEB_APP_URL'
};

var SETTING_DISPLAY_VALUES_ = {
  LABEL_MODE: {
    'SIM名': 'sim',
    '端末名': 'device',
    '固定名': 'fixed',
    '付けない': 'none'
  },
  LOG_UNAUTHORIZED: {
    'はい': 'yes',
    'いいえ': 'no'
  }
};

function parseSettingsRows_(rows) {
  var settings = {};
  for (var i = 1; i < rows.length; i++) {
    var item = String(rows[i][0] || '').trim();
    var key = SETTING_KEYS_[item];
    if (!key) continue;

    var value = String(rows[i][1] || '').trim();
    if (key === 'TOKEN' && !value) continue;
    var choices = SETTING_DISPLAY_VALUES_[key];
    if (choices) {
      if (!Object.prototype.hasOwnProperty.call(choices, value)) continue;
      value = choices[value];
    }
    settings[key] = value;
  }
  return settings;
}

function resolveLogMaxRows_(value) {
  var n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 1000;
}

function logExcessRows_(lastRow, maxRows) {
  return Math.max(0, lastRow - 1 - maxRows);
}

function duplicateFingerprint_(sms) {
  return JSON.stringify(['device', 'sim', 'from', 'body', 'receivedAt'].map(function (key) {
    return String(sms[key] || '');
  }));
}

function resolveSetupToken_(rows, legacyToken, generateToken) {
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === '合言葉') {
      return String(rows[i][1] || '').trim() || generateToken();
    }
  }
  return legacyToken || generateToken();
}

/**
 * 利用者が貼り付けた公開ウェブアプリ URL の形式だけを確認する。
 * 公開状態・到達可能性・このスクリプトとの対応は保証しない（疎通確認もしない）。
 */
function isWebAppUrl_(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/?#\s]+\/exec$/.test(String(url || '').trim());
}
