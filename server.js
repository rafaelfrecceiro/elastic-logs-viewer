// Logs Kibana — visor de logs dos clientes pelo Kibana de cada ambiente.
// Consulta o Elasticsearch através de /api/console/proxy do Kibana (mesmo login da tela).
// Rodar: node ferramentas/logs-kibana/server.js  → http://localhost:4600

const http = require('http');
const fs = require('fs');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* sem .env: usa o ambiente */ }

const PORT = Number(process.env.PORT || 4600);
const USER = process.env.KIBANA_USER || '';
const PASS = process.env.KIBANA_PASS || '';
const INDEX = process.env.KIBANA_INDEX || 'dockers-*';
const HOST = process.env.HOST || '127.0.0.1';
// Só manda o login para estes hosts (vírgula; "*.dominio" vale para subdomínios). Vazio = qualquer um.
const ALLOWED = (process.env.ALLOWED_HOSTS ?? '*.weon.com.br').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (process.env.KIBANA_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const baseCache = new Map();

// Aceita a URL do jeito que vier (host, /kibana, link de uma tela do Kibana) e devolve a base do Kibana.
async function resolveBase(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new Error('Informe a URL do cliente');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const allowed = !ALLOWED.length || ALLOWED.some(a => a.startsWith('*.') ? host.endsWith(a.slice(1)) || host === a.slice(2) : host === a);
  if (!allowed) throw new Error(`Host ${host} fora da lista permitida (${ALLOWED.join(', ')})`);
  let p = u.pathname;
  const cut = p.search(/\/(app|api|s\/[^/]+\/app)\//);
  if (cut >= 0) p = p.slice(0, cut);
  p = p.replace(/\/+$/, '');
  const candidates = [u.origin + p];
  if (!p) candidates.push(u.origin + '/kibana');

  const key = candidates[0];
  if (baseCache.has(key)) return baseCache.get(key);
  let last = '';
  for (const c of candidates) {
    try {
      const r = await fetch(c + '/api/status', { headers: { Authorization: AUTH } });
      if (r.ok) { baseCache.set(key, c); return c; }
      last = `${c}/api/status → HTTP ${r.status}` + (r.status === 401 ? ' (login do .env recusado)' : '');
    } catch (e) {
      last = `${c} → ${e.cause?.code || e.message}`;
    }
  }
  throw new Error('Kibana não encontrado: ' + last);
}

async function es(base, method, esPath, body) {
  const url = `${base}/api/console/proxy?path=${encodeURIComponent(esPath)}&method=${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: AUTH, 'kbn-xsrf': 'true', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`); }
  if (!r.ok || json.error) {
    const reason = json.error?.root_cause?.[0]?.reason || json.error?.reason || json.message || text.slice(0, 300);
    throw new Error(`HTTP ${r.status}: ${reason}`);
  }
  return json;
}

// Sintaxe do filtro (campo message):
//   abc def        → abc E def
//   "frase exata"  → frase
//   -termo         → exclui (também -"frase")
//   a OR b         → a OU b (OR em maiúsculas; encadeia: a OR b OR c)
//   abc* / a?c     → curinga dentro de uma palavra, sem diferenciar maiúsculas
function termClause(t) {
  if (!t.quoted && /[*?]/.test(t.term)) {
    return { wildcard: { message: { value: t.term.toLowerCase(), case_insensitive: true } } };
  }
  return { match_phrase: { message: t.term } };
}

function textFilters(q) {
  const tokens = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    const quoted = m[2] !== undefined;
    tokens.push({ neg: !!(m[1] || m[3]), term: quoted ? m[2] : m[4], quoted });
  }
  const must = [], mustNot = [];
  const groups = []; // cada grupo = termos ligados por OR
  let joinNext = false;
  for (const t of tokens) {
    if (!t.quoted && !t.neg && t.term === 'OR') { joinNext = groups.length > 0; continue; }
    if (t.neg) { mustNot.push(termClause(t)); joinNext = false; continue; }
    if (joinNext) groups[groups.length - 1].push(t); else groups.push([t]);
    joinNext = false;
  }
  for (const g of groups) {
    must.push(g.length === 1 ? termClause(g[0]) : { bool: { should: g.map(termClause), minimum_should_match: 1 } });
  }
  return { must, mustNot };
}

async function search(params) {
  const base = await resolveBase(params.url);
  const index = params.index || INDEX;
  const { must, mustNot } = textFilters(params.q);
  const filter = [{ range: { '@timestamp': { gte: params.from || 'now-1h', lte: params.to || 'now' } } }];
  if (params.containers?.length) {
    filter.push({ terms: { 'container_name.keyword': params.containers } });
  }
  const tail = !!params.after; // modo ao vivo: só o que chegou depois do último horário
  if (tail) filter.push({ range: { '@timestamp': { gte: params.after } } });

  const res = await es(base, 'POST', `${index}/_search`, {
    size: Math.min(Number(params.size) || 300, 2000),
    sort: [{ '@timestamp': tail ? 'asc' : 'desc' }],
    track_total_hits: !tail,
    _source: ['@timestamp', 'container_name', 'message', 'level', 'host'],
    query: { bool: { filter, must, must_not: mustNot } },
  });
  const hits = res.hits.hits.map(h => ({
    id: h._index + '/' + h._id,
    ts: h._source['@timestamp'],
    container: h._source.container_name,
    message: h._source.message,
  }));
  const t = res.hits.total;
  const total = typeof t === 'object' ? t.value + (t.relation === 'gte' ? '+' : '') : t;
  return { base, total, hits: tail ? hits : hits.reverse() };
}

async function containers(params) {
  const base = await resolveBase(params.url);
  const index = params.index || INDEX;
  const body = field => ({
    size: 0,
    query: { range: { '@timestamp': { gte: params.from || 'now-1h', lte: params.to || 'now' } } },
    aggs: { c: { terms: { field, size: 200 } } },
  });
  const res = await es(base, 'POST', `${index}/_search`, body('container_name.keyword'));
  return { base, containers: res.aggregations.c.buckets.map(b => ({ name: b.key, count: b.doc_count })) };
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && req.url.startsWith('/api/')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const params = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/search') return send(res, 200, await search(params));
      if (req.url === '/api/containers') return send(res, 200, await containers(params));
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
});

if (!USER || !PASS) console.warn('⚠ KIBANA_USER/KIBANA_PASS vazios — preencha ferramentas/logs-kibana/.env');
server.listen(PORT, HOST, () => console.log(`Logs Kibana em http://${HOST}:${PORT}  (índice padrão ${INDEX}; hosts: ${ALLOWED.join(', ') || 'qualquer'})`));
