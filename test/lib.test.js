'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helper');

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
