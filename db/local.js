'use strict';

var path = require('path');
var home = require('user-home');
var shell = require('shelljs');
var PouchDb = require('pouchdb');

var uvwlib = require('uvwlib');
var derefp = require('uvwlib/lib/utils/deref').p;
var nodeUtils = require('uvwlib/node/utils');

var simpleDispatch = require('uvwlib/xbar/simple-dispatch');

var XbarDb = uvwlib.class({
  init: function(opts) {
    opts = opts || {};
    this.homeDir = opts.homeDir ? path.resolve(opts.homeDir)
      : path.resolve(home, '.uvworkspace');
    shell.mkdir('-p', path.join(this.homeDir, 'db'));
  },

  homeDb: function() {
    return this._homeDb || (this._homeDb = new PouchDb('xbars-home', {
      prefix: path.join(this.homeDir, 'db') + '/'
    }));
  },

  getLoginUser: function(rootId) {
    return this.homeDb().get('_local/login')
    .then(function(login) {
      var r = rootId && login.roots && login.roots[rootId];
      return (r || login).user || {};
    })
    .catch(function(err) {
      return {};
    });
  },

  login: function(uid, rootId) {
    if (!uid || typeof uid !== 'string') return Promise.reject('invalid uid'); 

    var db = this.homeDb();
    return db.get('_local/login')
    .then(function(login) {
      var user;
      if (rootId) {
        user = derefp(['roots', rootId, 'user'], login);
        if (!user) return Promise.reject('invalid login structure');
        if (user.uid) {
          if (userId !== uid) {
            return Promise.reject('someone else already logged in');
          } else {
            return login.roots[rootId].user;
          }
        } else {
          user.uid = uid;
          user.rootId = rootId;
          return db.put(login).then(function() { return user });
        }
      } else {
        user = derefp(['user'], login);
        if (user.uid) {
          if (user.uid !== uid) {
            return Promise.reject('someone else already logged in');
          } else {
            return login.user;
          }
        } else {
          user.uid = uid;
          return db.put(login).then(function() { return login.user; });
        }
      }
    })
    .catch(function(err) { //TODO: check not found error
      var login = { _id: '_local/login' }, user;
      if (rootId) {
        user = derefp(['roots', rootId, 'user'], login);
        user.rootId = rootId;
      } else {
        user = derefp(['user'], login);
      }
      if (!user) return Promise.reject('invalid login structure');
      user.uid = uid; 
      return db.put(login).then(function() { return user; });
    });
  },

  logout: function(rootId) {
    var db = this.homeDb();
    return db.get('_local/login')
    .then(function(login) {
      var user;
      if (rootId) {
        user = derefp(['roots', rootId, 'user'], login);
      } else {
        user = derefp(['user'], login);
      }
      if (!user) return Promise.reject('invalid login structure');

      delete user.uid;
      return db.put(login).then(function() { return user; });
    })
    .catch(function(err) { //TODO: check not found error
      return;
    });
  },

  info: function(rootId) {
    return uvwlib.assign({
      what: 'xbar-db',
    });
  },

  getSite: function(rootId) {
    var sites = rootId && this.homeDb.load('sites');
    return sites && sites[rootId] || {};
  },

  getUser: function(rootId) {
    var site = rootId && this.getSite(rootId);
    var user = site && site.user;
    if (user && user.uid) return user;

    return this.homeDb.load('user') || {};
  },

  getUid: function(rootId) {
    return this.getUser(rootId).uid;
  },

  _obtainSite: function(rootId) {
    var db = this.homeDb;
    var sites = db.load('sites') || {}; 
    var site = sites[rootId] || (sites[rootId] = {});
    var user = site.user || (site.user = { rootId: rootId });
    return {
      sites: sites,
      site: site,
      user: user,
    };
  },

  saveUser: function(opts) {
    opts = opts || {};

    var db = this.homeDb;
    var rootId = opts.rootId, user;
    if (rootId) {
      var ret = this._obtainSite(rootId);
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

  createSession: function(sid, rootId, opts) {
    opts = opts || {};
    if (!sid) return 'missing sid';

    var user = this.getUser(rootId);
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

  joinSession: function(sid, rootId, opts) {
    opts = opts || {};
    if (!sid || !rootId) return 'missing sid or rootId';

    var user = this.getUser(rootId);
    if (!user.uid) return 'not logged in';

    var db = this.homeDb;
    var ss = db.load('sessions') || {};
    var sess = ss[sid] || (ss[sid] = { sid: sid });
    var join = sess.join || (sess.join = {}); 
    var info = join[rootId] || (join[rootId] = {});
    db.save('sessions', ss);

    return sess;
  },

  enterSession: function(sid, rootId) {
    if (!sid || !rootId) return 'missing sid or rootId';

    var join = this._joinInfo(sid, rootId);
    if (typeof join === 'string') return join;

    var ret = this._obtainSite(rootId);
    ret.user.sid = sid;
    return this.homeDb.save('sites', ret.sites);
  },

  _siteSid: function(rootId) {
    var site = this.getSite(rootId);
    return site.user && site.user.sid;
  },

  pushMessage: function(sid, rootId, msg) {
    if (!rootId, !msg) return 'missing rootId or msg';

    var user = this.getUser(rootId);
    if (!user.uid) return 'not logged in';

    sid = sid || this._siteSid(rootId);
    if (!sid) return 'missing sid';

    var ss = this.homeDb.load('sessions') || {};
    var sess = ss[sid] || (ss[sid] = { sid: sid });

    if (!sess.owner) return 'no owner';
    
    var msgs= sess.msgs || (sess.msgs = []);

    var msg2 = uvwlib.assign({}, msg, {
      rootId: rootId,
      uid: user.uid,
      ts: Date.now()
    });

    msgs.push(msg2);

    return this.homeDb.save('sessions', ss);
  },

  getSession: function(sid, rootId) {
    var ret = this._joinInfo(sid, rootId);
    if (typeof ret === 'string') return console.log(ret);

    return ret.session;
  },

  _joinInfo: function(sid, rootId) {
    if (!rootId) return 'missing rootId';

    var user = this.getUser(rootId);
    if (!user.uid) return 'not logged in';

    sid = sid || this._siteSid(rootId);
    if (!sid) return 'missing sid';

    var ss = this.homeDb.load('sessions') || {};

    var sess = ss[sid] || (ss[sid] = { sid: sid });
    if (!sess.owner) return 'no owner';

    var msgs = sess.msgs || (sess.msgs = []);
    var info = sess.join && sess.join[rootId];
    if (!info) return rootId + ' not a member';

    return {
      sid: sid,
      user: user,
      sessions: ss,
      session: sess,
      msgs: msgs,
      info: info,
    };
  },

  //COPY from pushMessage, to change
  pushMeta: function(sid, rootId, msg) {
    return this.pushMessage(sid, rootId, msg);
  },

  executeCommand: function(sid, rootId, req) {
    simpleDispatch(this, req.cmd, req.args, req.opts); 
  },

  cli_sync: function() {
    this.sync();
  },

  sync: function() {
    return console.log(nodeUtils.inspect({
      user: this.getUser(),
      sites: this.homeDb.load('sites'),
      sessions: this._tss(),
    }));
  },

  _tss: function() {
    return uvw.map(this.homeDb.load('sessions'), function(sess, sid) {
      return {
        sid: sid,
        join: uvw.map(sess.join || {}, function(info, rootId) {
          return {
            rootId: rootId,
            lastTs: info.lastTs || 0,
          };
        }),
      };
    });
  },
});

module.exports = XbarDb;

