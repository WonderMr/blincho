// Disposable wire-protocol fixture. Production authentication and persistence
// live in the private WonderMr/Blincho-Back repository.
const http = require('node:http');
const { randomBytes } = require('node:crypto');

function createProtocolServer({ registrationCode }) {
  const accounts = new Map(), sessions = new Map();
  const instance = randomBytes(16).toString('hex');
  return http.createServer(async (req, res) => {
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(status === 204 ? '' : JSON.stringify(payload));
    };
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/v1/register') {
        if (body.registrationCode !== registrationCode || accounts.has(body.email)) return reply(400, {});
        accounts.set(body.email, { accountId: body.accountId, email: body.email, password: body.password,
          keyCheck: body.keyCheck, documents: new Map(), events: [], cursor: 0 });
      }
      if (['/v1/register', '/v1/login'].includes(url.pathname)) {
        const account = accounts.get(body.email);
        if (!account || account.password !== body.password) return reply(401, {});
        const token = randomBytes(32).toString('base64url'); sessions.set(token, account);
        return reply(200, { token, accountId: account.accountId, keyCheck: account.keyCheck });
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const account = sessions.get(token);
      if (!account) return reply(401, {});
      if (url.pathname === '/v1/logout') { sessions.delete(token); return reply(204); }
      if (url.pathname === '/v1/delete-account') {
        if (body.password !== account.password) return reply(401, {});
        accounts.delete(account.email);
        for (const [token, owner] of sessions) if (owner === account) sessions.delete(token);
        return reply(204);
      }
      if (url.pathname === '/v1/state') return reply(200, { documents: [...account.documents].map(([id, doc]) => ({ id, ...doc })) });
      if (req.method === 'PUT' && url.pathname.startsWith('/v1/state/')) {
        const id = url.pathname.slice('/v1/state/'.length), previous = account.documents.get(id);
        if (body.baseRevision !== (previous?.revision ?? 0)) return reply(409, { revision: previous?.revision ?? 0 });
        const revision = (previous?.revision ?? 0) + 1;
        account.documents.set(id, { revision, envelope: body.envelope });
        return reply(200, { revision });
      }
      if (url.pathname === '/v1/events') {
        if (req.method === 'POST') {
          const seq = ++account.cursor; account.events.push({ seq, envelope: body.envelope });
          return reply(201, { seq });
        }
        return reply(200, { instance, cursor: account.cursor, events: account.events.filter(event => event.seq > Number(url.searchParams.get('after') || 0)) });
      }
      reply(404, {});
    } catch { reply(400, {}); }
  });
}
module.exports = { createProtocolServer };
