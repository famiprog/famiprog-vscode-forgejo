'use strict';

const http = require('http');
const crypto = require('crypto');

// 8081 so this can run on the host while k3d already publishes Forgejo on 8080.
// The cluster copy will listen on 8080 inside the pod.
const port = Number(process.env.PORT) || 8081;
// Empty when running `node server.js` on the host. /auth-app in the cluster.
const base = (process.env.BASE_PATH || '').replace(/\/$/, '');
const afterLogin = process.env.AFTER_LOGIN_URL || (base ? `${base}/` : '/');
// One shared password for every username. The lab manifest sets it; production sets its own.
const password = process.env.PASSWORD;
if (!password) {
  console.error('PASSWORD is required');
  process.exit(1);
}
const sessions = new Map();

function passwordMatches(given) {
  const attempt = Buffer.from(String(given));
  const expected = Buffer.from(password);
  if (attempt.length !== expected.length) return false;
  return crypto.timingSafeEqual(attempt, expected);
}

function under(suffix) {
  return `${base}${suffix}` || '/';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function userFrom(req) {
  const token = cookies(req).auth_app;
  if (!token) return null;
  return sessions.get(token) || null;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function validUsername(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function page(user, error) {
  const body = user
    ? `<p>Signed in as <strong>${escapeHtml(user)}</strong>.</p>
       <form method="post" action="${under('/logout')}"><button type="submit">Log out</button></form>`
    : `<form method="post" action="${under('/login')}">
         <label>Username <input name="username" autocomplete="username" required autofocus></label>
         <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
         <button type="submit">Log in</button>
       </form>
       ${error ? `<p>${escapeHtml(error)}</p>` : ''}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Forgejo auth</title>
</head>
<body>
  <h1>Forgejo auth</h1>
  ${body}
</body>
</html>
`;
}

function redirect(res, location, setCookie) {
  const headers = { Location: location };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(303, headers);
  res.end();
}

function logout(req, res) {
  const token = cookies(req).auth_app;
  if (token) sessions.delete(token);
  // Clear Forgejo's session cookie too. Sign out posts here, and that cookie
  // would otherwise keep the previous user after the next login.
  res.writeHead(303, {
    Location: under('/login'),
    'Set-Cookie': [
      'auth_app=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      'session=; HttpOnly; SameSite=Lax; Path=/forgejo; Max-Age=0',
    ],
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;

  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // nginx auth-url calls this. 200 plus these headers lets the request through.
  if (req.method === 'GET' && path === '/auth') {
    const user = userFrom(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('unauthenticated\n');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'X-WEBAUTH-USER': user,
      'X-WEBAUTH-EMAIL': `${user}@localhost`,
    });
    res.end(`authenticated as ${user}\n`);
    return;
  }

  if (req.method === 'GET' && (path === under('/') || path === base || path === under('/login'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(userFrom(req)));
    return;
  }

  if (req.method === 'POST' && path === under('/login')) {
    const form = await readForm(req);
    const username = (form.get('username') || '').trim();
    if (!validUsername(username)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(null, 'Use letters, digits, and . _ - (max 64 characters).'));
      return;
    }
    if (!passwordMatches(form.get('password') || '')) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(null, 'Wrong password.'));
      return;
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, username);
    redirect(res, afterLogin, `auth_app=${token}; HttpOnly; SameSite=Lax; Path=/`);
    return;
  }

  // Forgejo's Sign out posts to {subpath}/user/logout.
  if ((req.method === 'POST' && path === under('/logout')) || path === '/user/logout' || path === '/forgejo/user/logout') {
    logout(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`http://127.0.0.1:${port}/`);
});
