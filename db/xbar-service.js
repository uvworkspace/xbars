'use strict';

var uvwlib = require('uvwlib');

var LocalDb = require('./local');

var XbarService = uvwlib.class({
  init: function(name, rootCntx, opts) {
    opts = opts || {};

    this.name = name;
    this.rootCntx = rootCntx;
    this.rootId = rootCntx.rootId();
    this.db = LocalDb.instance();
  },
});

module.exports = XbarService;

