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
