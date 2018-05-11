'use strict';

var path = require('path');
var home = require('user-home');

var uvw = require('uvw-node');
var bsearch = require('uvwlib/lib/utils/bsearch');
var JsonStore = require('uvw-node/db/file-json-store');

var simpleDispatch = require('xbarlib/lib/simple-dispatch');

var XbarDb = uvw.class({
  init: function(opts) {
    opts = opts || {};
    var spec = uvw.findSpec(opts.cwd || process.cwd());
    this.homeDir = opts.homeDir ? path.resolve(opts.homeDir)
      : path.resolve(home, '.uvworkspace');
    this.homeDb = JsonStore.instance(path.join(this.homeDir, 'xbar.json'));
  },

  info: function(hashId) {
    return uvw.assign({
      what: 'xbar-db',
      homeDir: this.homeDir,
    }, this.getUser(hashId));
  },

  getSite: function(hashId) {
    var sites = hashId && this.homeDb.load('sites');
    return sites && sites[hashId] || {};
  },

  getUser: function(hashId) {
    var site = hashId && this.getSite(hashId);
    var user = site && site.user;
    if (user && user.uid) return user;

    return this.homeDb.load('user') || {};
  },

  getUid: function(hashId) {
    return this.getUser(hashId).uid;
  },

  _obtainSite: function(hashId) {
    var db = this.homeDb;
    var sites = db.load('sites') || {}; 
    var site = sites[hashId] || (sites[hashId] = {});
    var user = site.user || (site.user = { hashId: hashId });
    return {
      sites: sites,
      site: site,
      user: user,
    };
  },

  saveUser: function(opts) {
    opts = opts || {};

    var db = this.homeDb;
    var hashId = opts.hashId, user;
    if (hashId) {
      var ret = this._obtainSite(hashId);
      if (opts.uid) {
        ret.user.uid = opts.uid;
      } else {
        delete ret.user.uid;
      }
      return db.save('sites', ret.sites);
    } else {
      user = db.load('user') || {};
      if (opts.uid) {
        user.uid = opts.uid;
      } else {
        delete user.uid;
      }
      return db.save('user', user);
    }
  },

  createSession: function(sid, hashId, opts) {
    opts = opts || {};
    if (!sid) return 'missing sid';

    var user = this.getUser(hashId);
    if (!user.uid) return 'not logged in';

    var db = this.homeDb;
    var ss = db.load('sessions') || {};
    var sess = ss[sid] || (ss[sid] = { sid: sid });
    if (sess.owner && sess.owner !== user.uid) {
      return 'session created by ' + sess.owner;
    }

    sess.owner = user.uid;
    db.save('sessions', ss);
    return sess;
  },

  joinSession: function(sid, hashId, opts) {
    opts = opts || {};
    if (!sid || !hashId) return 'missing sid or hashId';

    var user = this.getUser(hashId);
    if (!user.uid) return 'not logged in';

    var db = this.homeDb;
    var ss = db.load('sessions') || {};
    var sess = ss[sid] || (ss[sid] = { sid: sid });
    var join = sess.join || (sess.join = {}); 
    var info = join[hashId] || (join[hashId] = {});
    db.save('sessions', ss);

    return sess;
  },

  enterSession: function(sid, hashId) {
    if (!sid || !hashId) return 'missing sid or hashId';

    var join = this._joinInfo(sid, hashId);
    if (typeof join === 'string') return join;

    var ret = this._obtainSite(hashId);
    ret.user.sid = sid;
    return this.homeDb.save('sites', ret.sites);
  },

  _siteSid: function(hashId) {
    var site = this.getSite(hashId);
    return site.user && site.user.sid;
  },

  pushMessage: function(sid, hashId, msg) {
    if (!hashId, !msg) return 'missing hashId or msg';

    var user = this.getUser(hashId);
    if (!user.uid) return 'not logged in';

    sid = sid || this._siteSid(hashId);
    if (!sid) return 'missing sid';

    var ss = this.homeDb.load('sessions') || {};
    var sess = ss[sid] || (ss[sid] = { sid: sid });

    if (!sess.owner) return 'no owner';
    
    var msgs= sess.msgs || (sess.msgs = []);

    var msg2 = uvw.assign({}, msg, {
      hashId: hashId,
      uid: user.uid,
      ts: Date.now()
    });

    msgs.push(msg2);

    return this.homeDb.save('sessions', ss);
  },

  getSession: function(sid, hashId) {
    var ret = this._joinInfo(sid, hashId);
    if (typeof ret === 'string') return console.log(ret);

    return ret.session;
  },

  _joinInfo: function(sid, hashId) {
    if (!hashId) return 'missing hashId';

    var user = this.getUser(hashId);
    if (!user.uid) return 'not logged in';

    sid = sid || this._siteSid(hashId);
    if (!sid) return 'missing sid';

    var ss = this.homeDb.load('sessions') || {};

    var sess = ss[sid] || (ss[sid] = { sid: sid });
    if (!sess.owner) return 'no owner';

    var msgs = sess.msgs || (sess.msgs = []);
    var info = sess.join && sess.join[hashId];
    if (!info) return hashId + ' not a member';

    return {
      sid: sid,
      user: user,
      sessions: ss,
      session: sess,
      msgs: msgs,
      info: info,
    };
  },

  next: function(sid, hashId, fn) {
    if (typeof fn !== 'function') return 'missing callback';

    var ret = this._joinInfo(sid, hashId);
    if (typeof ret === 'string') return ret;

    var info = ret.info;
    var msgs = ret.msgs;
    var i = bsearch.upperBound(ret.msgs, info.lastTs || 0, 'ts');
    if (i < msgs.length) {
      var msg = msgs[i]; 
      info.lastTs = msg.ts;
      this.homeDb.save('sessions', ret.sessions);
      fn(msg);
    }
  },

  nextTill: function(sid, hashId, till, fn) {
    if (typeof fn !== 'function') return 'missing callback';

    var ret = this._joinInfo(sid, hashId);
    if (typeof ret === 'string') return ret;

    var info = ret.info;
    var msgs = ret.msgs;
    till = till || Date.now();

    var msg;
    var i = bsearch.upperBound(msgs, info.lastTs || 0, 'ts');
    if (i < msgs.length && msgs[i].ts <= till) {
      while (i < msgs.length && msgs[i].ts <= till) {
        var msg = msgs[i]; 
        info.lastTs = msg.ts;
        fn(msg);
      }
      this.homeDb.save('sessions', ret.sessions);
    }
  },

  //COPY from pushMessage, to change
  pushMeta: function(sid, hashId, msg) {
    return this.pushMessage(sid, hashId, msg);
  },

  executeCommand: function(sid, hashId, req) {
    simpleDispatch(this, req.cmd, req.args, req.opts); 
  },

  cli_load: function(args, opts) {
    console.log("SimDb cli_load", args, opts);
    var fpath = args[0] || opts.file;
    var json = JSON.parse(require('fs').readFileSync(fpath, 'utf8'));
    console.log('LOAD:', JSON.stringify(json, null, 2));
  },

  cli_save: function(args, opts) {
    console.log("SimDb cli_save", args, opts);
    var fpath = args[0] || opts.file;
    require('fs').writeFileSync(fpath, JSON.stringify({
      user: this.homeDb.load('user'),
      sites: this.homeDb.load('sites'),
      sessions: this.homeDb.load('sessions'),
    }, null, 2));
  },

  cli_sync: function() {
    this.sync();
  },

  sync: function() {
    //if (this._sync) return;
    return console.log(uvw.inspect({
      user: this.getUser(),
      sites: this.homeDb.load('sites'),
      sessions: this._tss(),
    }));
  },

  _tss: function() {
    return uvw.map(this.homeDb.load('sessions'), function(sess, sid) {
      return {
        sid: sid,
        join: uvw.map(sess.join || {}, function(info, hashId) {
          return {
            hashId: hashId,
            lastTs: info.lastTs || 0,
          };
        }),
      };
    });
  },
});

module.exports = XbarDb;

