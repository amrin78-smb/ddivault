'use strict';
const path = require('path');
let oui = {};
try { oui = require(path.join(__dirname, '..', 'data', 'oui.json')); } catch (_) { oui = {}; }

function lookupOUI(mac) {
  if (!mac) return { vendor: 'Unknown', type: 'unknown' };
  const prefix = String(mac).replace(/[:\-\.]/g, '').toUpperCase().slice(0, 6);
  return oui[prefix] || { vendor: 'Unknown', type: 'unknown' };
}
module.exports = { lookupOUI };
