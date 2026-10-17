const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const READ_TOOLS = { get_status: 'status', get_settings: 'settings', get_today_stats: 'todayStats' };
const descriptions = {
  get_status: 'Read the current Blincho timer and presence state.',
  get_settings: 'Read Blincho settings. Does not expose credentials.',
  get_today_stats: 'Read aggregate totals for today, without activity or call history.',
  start_break: 'Request a break using the normal app controls.',
  pause_timer: 'Request pausing the work timer. Not available during a break or exercise.',
  resume_timer: 'Request resuming the work timer. Presence checks still apply.',
  skip_break: 'Request closing a break. Cannot bypass strict mode or a pending presence check.',
};
const tools = Object.entries(descriptions).map(([name, description]) => ({ name, description,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: name in READ_TOOLS, destructiveHint: false, idempotentHint: name in READ_TOOLS, openWorldHint: false } }));
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

function createLocalMcp({ preferredPort = 47831, now = Date.now } = {}) {
  let server, token = '', url = null, enabled = false, error = null, snapshot = null, publishedAt = 0;
  let commands = [], generation = 0, lifecycle = Promise.resolve();
  const state = () => {
    const running = enabled && !!server?.listening && !!token;
    return { enabled, running, url: running ? url : null, token: running ? token : null, error };
  };
  function dispatch(message) {
    const id = message?.id ?? null;
    const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) ||
      (message.id !== undefined && typeof message.id !== 'string' && !Number.isInteger(message.id))) return fail(-32600, 'Invalid request');
    if (message.id === undefined) return null;
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: PROTOCOLS.includes(message.params?.protocolVersion) ? message.params.protocolVersion : PROTOCOLS.at(-1),
        capabilities: { tools: {} }, serverInfo: { name: 'blincho', version: '1.0.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': {
        const name = message.params?.name, args = message.params?.arguments;
        if (!Object.hasOwn(descriptions, name)) return fail(-32602, 'Unknown tool');
        if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) return fail(-32602, 'Tool accepts no arguments');
        if (!snapshot || now() - publishedAt > 10000) { result = toolResult({ error: 'App state is unavailable. Open Blincho and retry.' }, true); break; }
        if (Object.hasOwn(READ_TOOLS, name)) result = toolResult(snapshot[READ_TOOLS[name]] ?? {});
        else {
          const current = snapshot.status ?? {};
          if (!Number.isSafeInteger(current.timerVersion) || current.timerVersion < 0 ||
            (current.breakEventId !== null && typeof current.breakEventId !== 'string')) {
            result = toolResult({ error: 'App state is unavailable.' }, true); break;
          }
          if (commands.length >= 16 || current.isIdlePaused || current.exercising ||
            (name !== 'skip_break' && current.isBreakActive) ||
            (name === 'skip_break' && (!current.isBreakActive || current.cameraChecking || (current.strictMode && !current.breakElapsed)))) {
            result = toolResult({ error: 'Action is unavailable in the current app state.' }, true); break;
          }
          commands.push({ name, timerVersion: current.timerVersion, breakEventId: current.breakEventId, at: now() });
          result = toolResult({ queued: true, action: name });
        }
        break;
      }
      default: return fail(-32601, 'Method not found');
    }
    return { jsonrpc: '2.0', id, result };
  }
  function handler(request, response) {
    const reply = (code, value) => { if (response.writableEnded) return; response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' }); response.end(value === undefined ? '' : JSON.stringify(value)); };
    if (!enabled || !server?.listening || !token) return reply(503);
    const host = new URL(url).host;
    if (request.headers.origin !== undefined || request.headers.host !== host) return reply(403);
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401);
    if (request.url !== '/mcp') return reply(404);
    if (request.method !== 'POST') return reply(405);
    if (request.headers['mcp-protocol-version'] && !PROTOCOLS.includes(request.headers['mcp-protocol-version'])) return reply(400);
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415);
    const accepted = (request.headers.accept ?? '').split(',').map(value => value.split(';')[0].trim());
    if (!accepted.includes('application/json') || !accepted.includes('text/event-stream')) return reply(400);
    if (Number(request.headers['content-length']) > 65536) { request.resume(); return reply(413); }
    let size = 0, chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) { chunks = []; request.pause(); response.once('finish', () => request.destroy()); reply(413); } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = dispatch(message);
        reply(result === null ? 202 : 200, result ?? undefined);
      } catch { reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    });
    request.on('error', () => { if (!response.writableEnded) reply(400); });
  }
  async function stop() {
    const previous = server;
    server = undefined; token = ''; url = null; commands = []; snapshot = null; publishedAt = 0;
    if (previous) await new Promise(resolve => { previous.close(resolve); previous.closeAllConnections(); });
  }
  async function configure(flag) {
    if (typeof flag !== 'boolean') throw new TypeError('MCP enabled must be boolean');
    const requested = ++generation;
    enabled = flag;
    // Revoke access immediately, even when a start operation is still queued.
    if (!flag) { token = ''; commands = []; }
    lifecycle = lifecycle.catch(() => {}).then(async () => {
      if (requested !== generation) return;
      if (!flag) { await stop(); error = null; return; }
      if (server?.listening && token) return;
      await stop(); error = null;
      token = randomBytes(32).toString('hex');
      const listen = port => new Promise((resolve, reject) => {
        const candidate = http.createServer({ maxHeaderSize: 8192 }, handler);
        candidate.headersTimeout = 5000; candidate.requestTimeout = 5000; candidate.timeout = 5000; candidate.maxConnections = 16;
        candidate.once('error', reject);
        candidate.listen(port, '127.0.0.1', () => { candidate.removeListener('error', reject); resolve(candidate); });
      });
      try {
        try { server = await listen(preferredPort); }
        catch (failure) { if (failure.code !== 'EADDRINUSE' || !preferredPort) throw failure; server = await listen(0); }
        url = `http://127.0.0.1:${server.address().port}/mcp`;
        server.on('error', failure => { error = failure.message; });
        if (requested !== generation) await stop();
      } catch (failure) { await stop(); error = failure.message; }
    });
    await lifecycle;
    return state();
  }
  return { configure, state, publish(value) {
    if (!enabled || !server?.listening) return;
    if (!value || typeof value !== 'object' || JSON.stringify(value).length > 32768) throw new TypeError('Invalid MCP snapshot');
    snapshot = JSON.parse(JSON.stringify(value)); publishedAt = now();
  }, takeCommands() {
    const result = enabled && server?.listening ? commands.filter(command => now() - command.at <= 5000)
      .map(({ name, timerVersion, breakEventId }) => ({ name, timerVersion, breakEventId })) : [];
    commands = []; return result;
  }, shutdown: () => configure(false) };
}

module.exports = { createLocalMcp };
