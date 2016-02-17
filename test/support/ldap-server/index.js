'use strict';

let fs = require('fs');
let path = require('path');
let ldap = require('ldapjs');

let server = ldap.createServer();

let passwd = path.join(__dirname, 'fakepasswd');

function authorize (req, res, next) {
  if (!req.connection.ldap.bindDN.equals('cn=root'))
    return next(new ldap.InsufficientAccessRightsError());
  return next();
}

let boundUsers = new Set();

function doBind (user) {
  server.bind(user.dn, function(req, res, next) {
    if (req.dn.toString() !== user.dn ||
        req.credentials !== user.attributes.pass)
      return next(new ldap.InvalidCredentialsError());
    res.end();
    return next();
  });
  boundUsers.add(user.dn);
}

function loadPasswdFile (req, res, next) {
  fs.readFile(passwd, 'utf8', function(err, data) {
    if (err)
      return next(new ldap.OperationsError(err.message));

    req.users = {};

    var lines = data.split('\n');
    lines.forEach(function(l) {
      if (!l || /^#/.test(l))
        return;

      var record = l.split(':');
      if (!record || !record.length)
        return;

      var user = {
        dn: 'cn=' + record[0] + ', ou=users, o=myhost',
        attributes: {
          cn: record[0],
          pass: record[1],
          uid: record[2],
          gid: record[3],
          description: record[4],
          homedirectory: record[5],
          shell: record[6] || '',
          objectclass: 'unixUser'
        }
      };

      req.users[record[0]] = user;

      if (!boundUsers.has(user.dn))
        doBind(user);
    });


    return next();
  });
}

let pre = [authorize, loadPasswdFile];


server.bind('cn=root', function(req, res, next) {
  if (req.dn.toString() !== 'cn=root' || req.credentials !== 'secret')
    return next(new ldap.InvalidCredentialsError());
  res.end();
  return next();
});


server.search('o=myhost', pre, function(req, res, next) {
  Object.keys(req.users).forEach(k => {
    if (req.filter.matches(req.users[k].attributes)) {
      res.send(req.users[k]);
    }
  });
  res.end();
  return next();
});

server.add('ou=users, o=myhost', pre, function(req, res, next) {
  if (!req.dn.rdns[0].attrs.cn)
    return next(new ldap.ConstraintViolationError('cn required'));

  if (req.users[req.dn.rdns[0].attrs.cn])
    return next(new ldap.EntryAlreadyExistsError(req.dn.toString()));

  var entry = req.toObject().attributes;

  if (entry.objectclass.indexOf('unixUser') === -1)
    return next(new ldap.ConstraintViolation('entry must be a unixUser'));

  let cn = entry.cn[0];
  let uid = entry.uid || '1001';
  let gid = entry.gid || '1000';
  let desc = entry.description || '';
  let homedir = entry.homedirectory || `/home/${cn}`;
  let shell = entry.shell || '/bin/bash';
  let line = `${cn}:x:${uid}:${gid}:${desc}:${homedir}:${shell}\n`;

  fs.appendFile(passwd, line, err => {
    if (err)
      return next(new ldap.OperationsError(err));
    res.end();
    return next();
  });

});

exports.start = function(port) {
  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
  });
};

exports.stop = function() {
  return Promise.resolve().then(() => {
    server.close();
  });
};

if (require.main === module) {
  exports.start(1389).
    then(() => {
      console.log('ldap-server started on port 1389');
    });
}
