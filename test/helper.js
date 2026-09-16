'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadLib() {
  const filename = path.join(__dirname, '..', 'gas', 'lib.js');
  const context = vm.createContext({ JSON, Date, Error, RegExp, String });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

module.exports = { loadLib };
