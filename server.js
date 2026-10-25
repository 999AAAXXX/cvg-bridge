/**
 * Converge/Enter.pro -> OpenAI-compatible bridge
 * 目标: opencode CLI 直接可用, 支持 tool calls / 流式 / prompt cache
 *
 * 上游: https://api.enter.pro/code/api/v1
 * 鉴权: Authorization: Bearer <Auth0 access_token JWT>
 *       token 来源二选一:
 *         1) jwt.txt        - 直接贴 access_token
 *         2) cookie.txt     - 浏览器里 /auth/session 用的 session cookie, 桥自动换 token 并续期
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const GATEWAY = CFG.gateway.replace(/\/$/, '');
const ORIGIN = CFG.origin || 'https://enter.converge.ai';
const PORT = CFG.port || 8097;

const F = (n) => path.join(ROOT, n);
const readMaybe = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------------------------- auth --------------------------------- */

function jwtExpMs(tok) {
  const p = String(tok).split('.');
  if (p.length !== 3) return 0;
  try {
    const b = Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const o = JSON.parse(b);
    return (o.exp || 0) * 1000;
  } catch { return 0; }
}

const auth = {
  token: '',
  expMs: 0,
  source: '',
  lastErr: '',
};

function loadStaticToken() {
  const direct = process.env.CONVERGE_JWT || readMaybe(F('jwt.txt'));
  if (direct && direct.split('.').length === 3) {
    auth.token = direct; auth.expMs = jwtExpMs(direct) || Date.now() + 3600e3; auth.source = 'jwt';
    return true;
  }
  return false;
}

/** 用 session cookie 到 BFF 换 access_token */
async function exchangeCookie() {
  const cookieRaw = process.env.CONVERGE_COOKIE || readMaybe(F('cookie.txt'));
  if (!cookieRaw) throw new Error('no cookie.txt / CONVERGE_COOKIE');
  // 支持 "name=value" 或裸 value(此时用 config.cookieName)
  let cookieHeader = cookieRaw;
  if (!cookieRaw.includes('=')) {
    const name = CFG.auth?.cookieName || 'session';
    cookieHeader = `${name}=${cookieRaw}`;
  }
  const cf = process.env.CONVERGE_CF_CLEARANCE || CFG.auth?.cfClearance || readMaybe(F('cf_clearance.txt'));

  const url = `${ORIGIN}/auth/session?include=access_token`;
  const r = await fetch(url, {
    headers: {
      'Cookie': cookieHeader,
      'Accept': 'application/json',
      'User-Agent': CFG.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': `${ORIGIN}/`,
      ...(cf ? { 'cf_clearance': cf } : {}),
    },
  });
  const text = await r.text();
  if (r.status === 204) throw new Error('204 no session (cookie 名不对或已过期)');
  if (!r.ok) throw new Error(`session ${r.status}: ${text.slice(0, 200)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('session 非 JSON: ' + text.slice(0, 200)); }
  const tok = j.accessToken || j.access_token || j.token?.accessToken || j.session?.accessToken
    || j.data?.accessToken || j.data?.access_token;
  if (!tok) throw new Error('session 里没有 access token: ' + JSON.stringify(j).slice(0, 300));
  auth.token = tok;
  auth.expMs = jwtExpMs(tok) || Date.now() + 1800e3;
  auth.source = 'cookie';
  log('[auth] token refreshed via cookie, exp in', Math.round((auth.expMs - Date.now()) / 1000), 's');
  return tok;
}

async function getToken(force = false) {
  if (!force && auth.token && Date.now() < auth.expMs - 60e3) return auth.token;
  if (!force && auth.source === 'jwt' && auth.token) return auth.token;
  if (process.env.CONVERGE_JWT || readMaybe(F('jwt.txt'))) { loadStaticToken(); return auth.token; }
  return exchangeCookie();
}

async function authBoot() {
  loadPool();
  if (loadStaticToken()) { log('[auth] static JWT loaded, exp', new Date(auth.expMs).toISOString()); return; }
  try { await exchangeCookie(); } catch (e) { auth.lastErr = e.message; log('[auth] initial exchange failed:', e.message); }
}

/* ------------------------------- account pool ----------------------------- */
/**
 * accounts.json: [{ sub, email, token, addedAt, credits, plan, threshold, cooldownUntil, lastErr }]
 * 规则:
 *   - 优先用 credits 充足 / 冷却已过 的账号
 *   - 上游 402 insufficient_quota -> 标记冷却 + 立刻切下一个账号重试同一请求
 *   - 401 -> 该账号 token 失效, 切下一个
 *   - 全部冷却 -> 返回 402, 附带各账号状态
 */
const pool = { list: [], active: 0, file: F('accounts.json') };

function decodeJwt(tok) {
  try {
    const p = String(tok).split('.');
    if (p.length !== 3) return {};
    const b = p[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
  } catch { return {}; }
}

function loadPool() {
  try {
    const raw = JSON.parse(fs.readFileSync(pool.file, 'utf8'));
    if (Array.isArray(raw)) {
      pool.list = raw.filter((a) => a && a.token);   // 兼容旧格式
    } else if (raw && Array.isArray(raw.accounts)) {
      pool.list = raw.accounts.filter((a) => a && a.token);
      pool.active = Number.isInteger(raw.active) ? raw.active : 0;
    }
  } catch {}
  // 兼容: 只有 jwt.txt 时自动建池
  if (!pool.list.length) {
    const j = readMaybe(F('jwt.txt'));
    if (j && j.split('.').length === 3) {
      const p = decodeJwt(j);
      pool.list.push({
        sub: p.sub || 'default', email: p.email || p.sub || 'default',
        token: j, addedAt: new Date().toISOString(),
        credits: null, plan: null, threshold: null, cooldownUntil: 0, lastErr: '',
      });
    }
  }
  if (pool.active >= pool.list.length) pool.active = 0;
  savePool();
  syncJwtFile();
  log('[pool] 载入账号', pool.list.length, '个, 当前 active =', pool.list[pool.active]?.email || '-');
}

function syncJwtFile() {
  const a = pool.list[pool.active];
  if (a && a.token) {
    fs.writeFileSync(F('jwt.txt'), a.token);
    auth.token = a.token;
    auth.expMs = jwtExpMs(a.token) || Date.now() + 1800e3;
    auth.source = 'pool';
  }
}

function savePool() {
  try {
    fs.writeFileSync(pool.file, JSON.stringify({ active: pool.active, accounts: pool.list }, null, 2));
  } catch (e) { log('[pool] save fail', e.message); }
}

function tokenAlive(a) {
  const exp = decodeJwt(a.token).exp;
  return !exp || exp * 1000 > Date.now() + 60e3;
}

function accountReady(a) {
  if (!a || !a.token) return false;
  if (!tokenAlive(a)) return false;
  if (a.cooldownUntil && a.cooldownUntil > Date.now()) return false;
  if (a.credits != null && a.threshold != null && a.credits < a.threshold) return false;
  return true;
}

/** 从 active 开始找第一个可用账号, 返回索引或 -1 */
function accountAllows(a, model) {
  if (!a) return false;
  if (!Array.isArray(a.models) || !a.models.length) return true;   // 未设白名单 = 全放
  if (!model) return true;
  return a.models.includes(model);
}

function pickAccount(model) {
  const n = pool.list.length;
  for (let k = 0; k < n; k++) {
    const i = (pool.active + k) % n;
    const a = pool.list[i];
    if (!accountAllows(a, model)) continue;
    if (accountReady(a)) return i;
  }
  // 兜底: 余额低但 token 有效且不在冷却 -> 仍然打一次, 让上游给出真实原因
  if (CFG.pool?.tryAnyway !== false) {
    let best = -1, bestCr = -1;
    for (let i = 0; i < n; i++) {
      const a = pool.list[i];
      if (!a || !a.token) continue;
      if (!accountAllows(a, model)) continue;
      if (!tokenAlive(a)) continue;
      if (a.cooldownUntil && a.cooldownUntil > Date.now()) continue;
      const cr = a.credits == null ? 0 : a.credits;
      if (cr > bestCr) { bestCr = cr; best = i; }
    }
    if (best >= 0) { log('[pool] 无健康账号, 兜底试额度最高的', pool.list[best]?.email, bestCr); return best; }
  }
  return -1;
}

function rotate(prevIdx, reason) {
  const n = pool.list.length;
  if (!n) return;
  if (prevIdx >= 0 && pool.list[prevIdx]) pool.list[prevIdx].lastErr = reason || '';
  pool.active = (prevIdx + 1) % n;
  savePool(); syncJwtFile();
  log('[pool] rotate', prevIdx, '->', pool.active, '(' + (reason || '') + ')');
}

function upsertAccount(token, extra = {}) {
  const p = decodeJwt(token);
  const sub = p.sub || 'unknown-' + Date.now();
  const email = p.email || extra.email || sub;
  const rec = {
    sub, email, token,
    addedAt: new Date().toISOString(),
    credits: null, plan: null, threshold: null,
    cooldownUntil: 0, lastErr: '',
    ...(Array.isArray(extra.models) && extra.models.length ? { models: extra.models } : {}),
  };
  const i = pool.list.findIndex((a) => a.sub === sub);
  if (i >= 0) pool.list[i] = { ...pool.list[i], ...rec };
  else pool.list.push(rec);
  pool.active = i >= 0 ? i : pool.list.length - 1;
  savePool();
  fs.writeFileSync(F('jwt.txt'), token);
  auth.token = token; auth.expMs = jwtExpMs(token) || Date.now() + 1800e3; auth.source = 'pool';
  wsCache.clear();
  log('[pool] upsert 账号', email, '| active =', pool.active, '| 池大小', pool.list.length);
  return pool.list[pool.active];
}

/** 拉某个账号的额度/套餐, 顺带判断是否可用 */
async function fetchCredits(token, wsId) {
  if (!wsId) return null;
  const r = await fetch(GATEWAY + '/workspaces/' + wsId + '/credits', {
    headers: { 'Authorization': 'Bearer ' + token, 'Origin': ORIGIN, 'Accept': 'application/json' },
  });
  if (r.status === 401) return { unauthorized: true };
  if (!r.ok) return null;
  const j = await r.json();
  const d = j?.data || {};
  return {
    credits: d?.credits_balance?.total ?? d?.credits ?? null,
    status: d?.credits_balance?.status ?? null,
    threshold: d?.credits_balance?.low_credits_threshold ?? null,
    breakdown: d?.credits_balance?.breakdown || null,
    deferred: d?.deferred_charge_summary?.deferred_credits_usage ?? null,
    deferredCents: d?.deferred_charge_summary?.deferred_credit_cents ?? null,
    ledger: d?.deferred_charge_summary?.ledger_count ?? null,
  };
}

async function refreshAccount(i) {
  const a = pool.list[i];
  if (!a) return null;
  try {
    const r = await fetch(GATEWAY + '/workspaces', {
      headers: { 'Authorization': 'Bearer ' + a.token, 'Origin': ORIGIN, 'Accept': 'application/json' },
    });
    if (r.status === 401) { a.lastErr = 'token invalid'; a.cooldownUntil = Date.now() + 3600e3; return a; }
    const j = await r.json();
    const w = j?.data?.workspaces?.[0];
    if (w) {
      a.credits = w?.credits_balance?.total ?? null;
      a.threshold = w?.credits_balance?.low_credits_threshold ?? null;
      a.plan = w?.plan_type ?? null;
      a.wsId = String(w.id);
      a.entitled = (w?.entitlement?.ai_all_models || []).length;
      if (a.credits != null && a.threshold != null && a.credits < a.threshold) {
        a.lastErr = 'credits ' + a.credits + ' < ' + a.threshold;
      }
      const c = await fetchCredits(a.token, a.wsId);
      if (c && !c.unauthorized) {
        a.credits = c.credits;
        a.status = c.status;
        a.threshold = c.threshold;
        a.breakdown = c.breakdown;
        a.deferred = c.deferred;
        a.ledger = c.ledger;
        a.checkedAt = new Date().toISOString();
      }
    }
  } catch (e) { a.lastErr = e.message; }
  savePool();
  return a;
}

async function refreshAllAccounts() {
  const out = [];
  for (let i = 0; i < pool.list.length; i++) out.push(await refreshAccount(i));
  return out;
}

/* -------------------------------- catalog -------------------------------- */

let catalog = { at: 0, pub: [], cap: [] };

async function loadCatalog(force = false) {
  if (!force && Date.now() - catalog.at < 5 * 60e3 && catalog.pub.length) return catalog;
  const get = async (p) => {
    const r = await fetch(GATEWAY + p, { headers: { 'Origin': ORIGIN, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(p + ' ' + r.status);
    return r.json();
  };
  const pub = (await get('/models')).data?.models || [];
  const cap = (await get('/ai-capability/models')).data?.models || [];
  catalog = { at: Date.now(), pub, cap };
  return catalog;
}

const protoOf = (pubId) => {
  const short = pubId.includes('/') ? pubId.split('/').pop() : pubId;
  const hit = catalog.cap.find((m) => m.id === pubId || m.id.endsWith('/' + short));
  return hit?.protocol || 'openai_chat_completions';
};

/* --------------------------------- cache --------------------------------- */

/** 稳定 hash: 只由 模型+system+tools 决定, 保证命中上游 prefix cache */
function stablePrefixKey(body) {
  const sys = (body.messages || []).filter((m) => m.role === 'system' || m.role === 'developer');
  const h = crypto.createHash('sha256');
  h.update(String(body.model || ''));
  h.update(JSON.stringify(sys));
  if (body.tools) h.update(JSON.stringify(body.tools));
  return 'cvg-' + h.digest('hex').slice(0, 32);
}

const diskCache = new Map();

/* ---- 用量台账: 每次调用记录 cached_tokens, 供 /api/usage 查 ---- */
const usageLog = [];
try {
  const f = F('usage.jsonl');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { usageLog.push(JSON.parse(line)); } catch {}
    }
    if (usageLog.length > 200) usageLog.splice(0, usageLog.length - 200);
  }
} catch {}
function estCredits(model, prompt, cached, completion) {
  try {
    const cap = catalog.cap || [];
    const short = String(model).includes('/') ? String(model).split('/').pop() : model;
    const m = cap.find((x) => x.id === model) || cap.find((x) => x.id.endsWith('/' + short));
    const p = m && m.sku_prices ? m.sku_prices : null;
    if (!p) return null;
    const pin = p.input_token?.price_per_k_credits ?? 0;
    const pout = p.output_token?.price_per_k_credits ?? 0;
    const pcr = p.cache_read_token?.price_per_k_credits ?? pin;
    const fresh = Math.max(0, prompt - cached);
    return Math.round(((fresh / 1000) * pin + (cached / 1000) * pcr + (completion / 1000) * pout) * 1000) / 1000;
  } catch { return null; }
}

function recordUsage(model, usage, extra = {}) {
  if (!usage) return null;
  const isAnthropic = usage.input_tokens !== undefined || usage.cache_read_input_tokens !== undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0;
  // Anthropic 口径: input_tokens 不含缓存读写, 需相加才是完整 prompt
  const prompt = isAnthropic
    ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
    : (usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const rec = {
    t: new Date().toISOString(), model,
    prompt, cached, completion,
    cacheRate: prompt ? Math.round((cached / prompt) * 1000) / 10 : 0,
    cacheWrite: usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_write_tokens ?? 0,
    estCredits: estCredits(model, prompt, cached, completion),
    ...extra,
  };
  usageLog.push(rec);
  if (usageLog.length > 200) usageLog.shift();
  try { fs.appendFileSync(F('usage.jsonl'), JSON.stringify(rec) + '\n'); } catch {}
  log(`[usage] ${model} prompt=${prompt} cached=${cached} (${rec.cacheRate}%) completion=${completion}`);
  return rec;
}

function diskGet(k) {
  const e = diskCache.get(k);
  if (!e) return null;
  if (e.exp < Date.now()) { diskCache.delete(k); return null; }
  return e.v;
}
function diskPut(k, v, ttl) {
  if (diskCache.size > 500) diskCache.delete(diskCache.keys().next().value);
  diskCache.set(k, { v, exp: Date.now() + ttl * 1000 });
}

/* --------------------------------- http ---------------------------------- */

function send(res, code, obj, extra = {}) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, ...extra });
  res.end(b);
}

const OPENAI_ERR = (msg, type = 'upstream_error', code = 500) => ({
  error: { message: String(msg), type, code },
});

async function upstreamStream(upRes, res, onUsage) {
  res.writeHead(upRes.status, {
    'Content-Type': upRes.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(res.getHeader('X-Bridge-Downgraded') ? { 'X-Bridge-Downgraded': res.getHeader('X-Bridge-Downgraded') } : {}),
  });
  const reader = upRes.body.getReader();
  const dec = new TextDecoder();
  let tail = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      if (onUsage) {
        tail += dec.decode(value, { stream: true });
        if (tail.length > 8192) tail = tail.slice(-8192);
      }
    }
  } catch (e) {
    log('[stream] broken:', e.message);
  } finally {
    try { res.end(); } catch {}
    if (onUsage && tail) {
      // 从流尾部找最后一个 "usage":{...}
      const i = tail.lastIndexOf('"usage"');
      if (i >= 0) {
        const s = tail.indexOf('{', i);
        let depth = 0, end = -1;
        for (let k = s; k < tail.length; k++) {
          if (tail[k] === '{') depth++;
          else if (tail[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
        }
        if (end > s) {
          try { onUsage(JSON.parse(tail.slice(s, end))); } catch {}
        }
      }
    }
  }
}

async function callGateway(pathname, body, { stream, token }) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'Origin': ORIGIN,
    'Referer': ORIGIN + '/',
    'User-Agent': CFG.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const ws = await getWorkspace(token).catch(() => '');
  if (ws) headers['X-Workspace-ID'] = ws;
  return fetch(GATEWAY + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** 工作区 id: 网关要求数字 id (X-Workspace-ID), 从 /workspaces 自动取 */
const wsCache = new Map();   // key: 账号 sub -> { id, at }
const wsKey = (token) => {
  const sub = decodeJwt(token).sub;
  return sub || ('tok:' + String(token).slice(-24));
};

async function getWorkspace(token) {
  const k = wsKey(token);
  const hit = wsCache.get(k);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.id;
  const r = await fetch(GATEWAY + '/workspaces', {
    headers: { 'Authorization': 'Bearer ' + token, 'Origin': ORIGIN, 'Accept': 'application/json' },
  });
  const j = await r.json();
  const list = j?.data?.workspaces || [];
  if (!list.length) throw new Error('no workspace for ' + k);
  const id = String(list[0].id);
  wsCache.set(k, { id, at: Date.now() });
  log('[ws]', k, '-> workspace', id, '| plan =', list[0].plan_type, '| credits =', list[0]?.credits_balance?.total);
  return id;
}

/* -------------------------------- routes --------------------------------- */

async function handleModels(res) {
  const c = await loadCatalog().catch(() => catalog);
  const data = (c.pub.length ? c.pub : []).map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'converge',
    // 非标准但 opencode 会读到
    protocol: m.protocol,
    name: m.name,
  }));
  if (!data.length) data.push({ id: 'auto', object: 'model', owned_by: 'converge' });
  send(res, 200, { object: 'list', data });
}

/**
 * 缓存策略:
 *   openai_chat_completions / openai_responses / gemini:
 *     上游自动前缀缓存, 只需稳定前缀 + prompt_cache_key(已注入)
 *   anthropic_messages:
 *     必须显式 cache_control 断点, 否则 0 命中
 *     这里自动给 system 末块 + 最后一个 tool 打 ephemeral 断点
 */
function applyAnthropicBreakpoints(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let touched = false;

  // system 断点: 把字符串换成带 cache_control 的块
  const sysIdx = msgs.findIndex((m) => m.role === 'system' || m.role === 'developer');
  if (sysIdx >= 0) {
    const m = msgs[sysIdx];
    if (typeof m.content === 'string') {
      msgs[sysIdx] = { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
      touched = true;
    } else if (Array.isArray(m.content) && m.content.length) {
      const last = m.content[m.content.length - 1];
      if (last && last.type === 'text' && !last.cache_control) {
        last.cache_control = { type: 'ephemeral' };
        touched = true;
      }
    }
  }

  // tools 断点: 打在最后一个工具上, 覆盖整个工具定义前缀
  if (Array.isArray(body.tools) && body.tools.length) {
    const lastTool = body.tools[body.tools.length - 1];
    if (lastTool && !lastTool.cache_control) {
      lastTool.cache_control = { type: 'ephemeral' };
      touched = true;
    }
  }

  // 最后一条 user 消息也打个断点, 让多轮对话稳定命中
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    if (typeof msgs[i].content === 'string' && msgs[i].content.length > 200) {
      msgs[i] = { role: 'user', content: [{ type: 'text', text: msgs[i].content, cache_control: { type: 'ephemeral' } }] };
      touched = true;
    }
    break;
  }
  return touched;
}

function stripBreakpoints(body) {
  const b = JSON.parse(JSON.stringify(body));
  for (const m of b.messages || []) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) delete part.cache_control;
    }
  }
  for (const t of b.tools || []) delete t.cache_control;
  return b;
}

/**
 * 平滑流: 上游常常把整段内容一次性塞过来, 这里解析后重新切块并按节奏吐出,
 * 让页面 / opencode 看到的是逐字增长而不是"唰一下全出"。
 */
async function smoothStream(upRes, res, onUsage) {
  const chunkChars = CFG.stream?.chunkChars ?? 4;
  const tickMs = CFG.stream?.tickMs ?? 22;
  res.writeHead(upRes.status, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(res.getHeader('X-Bridge-Downgraded') ? { 'X-Bridge-Downgraded': res.getHeader('X-Bridge-Downgraded') } : {}),
  });

  const reader = upRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let tpl = { id: 'chatcmpl-bridge', created: Math.floor(Date.now() / 1000), model: 'unknown' };
  let finishReason = null;
  let usage = null;
  const queue = [];
  let closed = false;

  const emit = (obj) => { if (!closed) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} } };

  const timer = setInterval(() => {
    if (!queue.length) return;
    const piece = queue.splice(0, chunkChars).join('');
    if (piece) emit({ id: tpl.id, object: 'chat.completion.chunk', created: tpl.created, model: tpl.model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }, tickMs);

  const drain = () => new Promise((r) => {
    const t = setInterval(() => { if (!queue.length) { clearInterval(t); r(); } }, Math.max(10, tickMs));
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const ln of lines) {
        if (!ln.startsWith('data:')) continue;
        const d = ln.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        let o; try { o = JSON.parse(d); } catch { continue; }
        if (o.id) tpl.id = o.id;
        if (o.model) tpl.model = o.model;
        if (o.created) tpl.created = o.created;

        const ch = o.choices?.[0];
        const delta = ch?.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          for (const c of delta.content) queue.push(c);
        }
        // 推理内容 / 工具调用 / 其他字段: 立即原样转发
        const passthrough = { ...delta };
        delete passthrough.content;
        if (Object.keys(passthrough).length) {
          emit({ id: tpl.id, object: 'chat.completion.chunk', created: tpl.created, model: tpl.model,
            choices: [{ index: 0, delta: passthrough, finish_reason: ch?.finish_reason ?? null }] });
        }
        if (ch?.finish_reason) finishReason = ch.finish_reason;
        if (o.usage) usage = o.usage;
      }
    }
    await drain();
    emit({ id: tpl.id, object: 'chat.completion.chunk', created: tpl.created, model: tpl.model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }] });
    if (usage) {
      emit({ id: tpl.id, object: 'chat.completion.chunk', created: tpl.created, model: tpl.model,
        choices: [], usage });
      if (onUsage) { try { onUsage(usage); } catch {} }
    }
    if (!closed) { try { res.write('data: [DONE]\n\n'); } catch {} }
  } catch (e) {
    log('[smooth] broken:', e.message);
  } finally {
    clearInterval(timer);
    closed = true;
    try { res.end(); } catch {}
  }
}

async function handleChat(req, res, raw) {
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, OPENAI_ERR('bad json', 'invalid_request_error', 400)); }

  const stream = !!body.stream;
  const isResponsesModel = protoOf(body.model) === 'openai_responses';



  const cacheKey = CFG.cache?.diskCache ? crypto.createHash('sha256')
    .update(JSON.stringify({ ...body, stream: false })).digest('hex') : null;
  if (cacheKey && !stream) {
    const hit = diskGet(cacheKey);
    if (hit) { log('[cache] hit', body.model); return send(res, 200, hit, { 'X-Bridge-Cache': 'HIT' }); }
  }

  // ===== 统一缓存策略: 所有模型默认开启, 不依赖逐个验证 =====
  const proto = protoOf(body.model);
  const cacheOn = CFG.cache?.enabled !== false;
  const isAnthropicProto = proto === 'anthropic_messages';
  const isGemini = String(proto).includes('gemini');
  const isResponsesProto = proto === 'openai_responses';

  if (cacheOn) {
    // (a) 所有模型: 稳定前缀键（OpenAI/Gemini/Kimi/Qwen/GLM/DeepSeek/MiniMax 等自动前缀缓存都用它）
    if (!body.prompt_cache_key) body.prompt_cache_key = stablePrefixKey(body);

    // (b) OpenAI 系: 延长保留期, 让跨轮/跨天复用
    if (!isAnthropicProto && !isGemini && body.prompt_cache_retention === undefined) {
      body.prompt_cache_retention = CFG.cache?.retention || '24h';
    }
    // OpenAI Responses 协议需要 store 才会落缓存
    if (isResponsesProto && body.store === undefined) body.store = true;

    // (c) Anthropic 系: 显式断点（不设就 0 命中）
    if (isAnthropicProto && CFG.cache?.anthropicBreakpoints !== false) {
      const touched = applyAnthropicBreakpoints(body);
      if (touched) body.__bridgeBreakpoints = 1;
    }
    // Gemini: 隐式缓存靠前缀稳定, 不做额外字段（多余字段会被拒）
    log('[cache] policy', body.model, '|', isAnthropicProto ? 'cache_control' : (isGemini ? 'implicit-prefix' : 'auto-prefix'), '| key=' + body.prompt_cache_key.slice(0, 18));
  }

  const pathname = CFG.forceResponsesPath && isResponsesModel ? '/responses' : '/chat/completions';

  // —— 多号轮询: 401 换号 / 402 额度耗尽换号, 同一请求自动重试 ——
  let token = '';
  let up = null;
  let usedIdx = -1;
  let lastQuotaBody = '';
  const tried = new Set();
  const maxTry = Math.max(1, pool.list.length);

  for (let attempt = 0; attempt < maxTry; attempt++) {
    const idx = pickAccount(body.model);
    if (idx < 0 || tried.has(idx)) break;
    tried.add(idx);
    usedIdx = idx;
    token = pool.list[idx].token;

    const sendBody = body.__bridgeBreakpoints ? (() => { const c = { ...body }; delete c.__bridgeBreakpoints; return c; })() : body;
    up = await callGateway(pathname, sendBody, { stream, token });
    if (body.__bridgeBreakpoints && (up.status === 400 || up.status === 422)) {
      const t0 = await up.clone().text();
      if (/cache_control|cache_control.*invalid|unknown.*field/i.test(t0)) {
        log('[cache] 上游不接受 cache_control, 去掉断点重试');
        const clean = stripBreakpoints(body);
        delete clean.__bridgeProgress;
        up = await callGateway(pathname, clean, { stream, token });
      }
    }
    if (up.status === 401) {
      const a = pool.list[idx];
      if (a) { a.lastErr = 'token 401'; a.cooldownUntil = Date.now() + 3600e3; }
      log('[pool] 401 on', pool.list[idx]?.email, '-> next');
      rotate(idx, 'token 401');
      continue;
    }
    if (up.status === 402 || up.status === 429) {
      const t = await up.text();
      if (/insufficient|quota|credit/i.test(t)) {
        const a = pool.list[idx];
        if (a) {
          const c = await fetchCredits(a.token, a.wsId).catch(() => null);
          a.credits = c && !c.unauthorized ? c.credits : 0;
          a.threshold = c ? c.threshold : a.threshold;
          a.lastErr = 'insufficient credits (上游拒绝)';
          a.cooldownUntil = Date.now() + 60e3;
        }
        lastQuotaBody = t;
        log('[pool] 额度耗尽 on', pool.list[idx]?.email, '-> 切号重试');
        rotate(idx, 'insufficient credits');
        up = null;
        continue;
      }
      return send(res, up.status, OPENAI_ERR(t.slice(0, 1500), 'upstream_error', up.status));
    }
    break;
  }

  if (!up) {
    const st = pool.list.map((a) => ({
      email: a.email, credits: a.credits, threshold: a.threshold,
      cooldown: a.cooldownUntil ? Math.max(0, Math.round((a.cooldownUntil - Date.now()) / 1000)) : 0,
      allowed: accountAllows(a, body.model),
      allowlist: a.models || null,
      err: accountAllows(a, body.model) ? a.lastErr : '模型不在该号白名单',
    }));
    return send(res, 402, {
      error: {
        message: '所有账号都不可用：' + st.map((a) =>
            `${a.email}（credits ${a.credits}，阈值 ${a.threshold}，冷却 ${a.cooldown}s，${a.err || '无说明'}）`).join('；')
          + '。补号：浏览器控制台跑 ingest 片段。日额度 08:00（北京）重置。',
        type: 'insufficient_quota',
        code: 402,
        accounts: st,
        upstream: lastQuotaBody.slice(0, 400),
      },
    });
  }

  if (usedIdx >= 0) pool.active = usedIdx;

  if (up.status >= 400) {
    const t = await up.text();
    log('[up]', up.status, t.slice(0, 300));
    return send(res, up.status, OPENAI_ERR(t.slice(0, 2000), 'upstream_error', up.status));
  }

  if (stream) {
    if (CFG.stream?.smooth === false) return upstreamStream(up, res, (u) => recordUsage(body.model, u, { via: 'chat/stream' }));
    // usage 由 smoothStream 内部回传
    return smoothStream(up, res, (u) => recordUsage(body.model, u, { via: 'chat/stream' }));
  }

  const json = await up.json();
  recordUsage(body.model, json.usage, { via: 'chat' });
  if (cacheKey) diskPut(cacheKey, json, CFG.cache?.diskCacheTtl || 3600);
  send(res, 200, json, cacheKey ? { 'X-Bridge-Cache': 'MISS' } : {});
}

/** Anthropic 原生透传: 给 opencode 的 anthropic provider 用, 保留 cache_control */
async function handleMessages(req, res, raw) {
  let body; try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, OPENAI_ERR('bad json', '', 400)); }
  const stream = !!body.stream;
  let token = '';
  let up = null;
  const triedM = new Set();
  for (let attempt = 0; attempt < Math.max(1, pool.list.length); attempt++) {
    const idx = pickAccount(body.model);
    if (idx < 0 || triedM.has(idx)) break;
    triedM.add(idx);
    token = pool.list[idx].token;
    up = await callGateway('/messages', body, { stream, token });
    if (up.status === 401) {
      const a = pool.list[idx]; if (a) { a.lastErr = 'token 401'; a.cooldownUntil = Date.now() + 3600e3; }
      rotate(idx, 'messages token 401'); continue;
    }
    if (up.status === 402 || up.status === 429) {
      const t = await up.text();
      if (/insufficient|quota|credit/i.test(t)) {
        const a = pool.list[idx]; if (a) { a.credits = 0; a.lastErr = 'insufficient credits'; a.cooldownUntil = Date.now() + 60e3; }
        rotate(idx, 'messages insufficient credits'); up = null; continue;
      }
      return send(res, up.status, OPENAI_ERR(t.slice(0, 1200), 'upstream_error', up.status));
    }
    break;
  }
  if (!up) return send(res, 402, { error: { message: '账号池内所有账号都不可用', type: 'insufficient_quota', code: 402 } });
  if (up.status >= 400) { const t = await up.text(); return send(res, up.status, OPENAI_ERR(t.slice(0, 1500), 'upstream_error', up.status)); }
  if (stream) return upstreamStream(up, res, (u) => recordUsage(body.model, u, { via: 'messages/stream' }));
  const j = await up.json();
  recordUsage(body.model, j.usage, { via: 'messages' });
  send(res, 200, j);
}

/* --------------------------------- main ---------------------------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type,anthropic-version,x-api-key',
    });
    return res.end();
  }

  let raw = '';
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks).toString('utf8');
    if (CFG.debug) log('[req]', u.pathname, raw.slice(0, 300));
  }

  try {
    /* 浏览器控制台一键推送 token: POST /ingest-token {"token":"eyJ..."} */
    if (u.pathname === '/ingest-token' && req.method === 'POST') {
      let t = '';
      try { t = (JSON.parse(raw || '{}').token || '').trim(); } catch {}
      if (!t) return send(res, 400, { ok: false, err: 'empty token' });
      if (t.split('.').length !== 3) return send(res, 400, { ok: false, err: 'not a 3-part JWT', head: t.slice(0, 60) });
      let allow = null;
      try { allow = JSON.parse(raw || '{}').models || null; } catch {}
      const added = upsertAccount(t, { models: Array.isArray(allow) ? allow : null });
      await refreshAccount(pool.active).catch(() => {});
      const v = await fetch(GATEWAY + '/users/info', {
        headers: { 'Authorization': 'Bearer ' + t, 'Origin': ORIGIN, 'Accept': 'application/json' },
      }).then(async (r) => ({ code: r.status, body: (await r.text()).slice(0, 300) })).catch((e) => ({ code: 0, body: e.message }));
      log('[ingest] token saved, verify ->', v.code);
      return send(res, 200, {
        ok: v.code === 200, verify: v,
        account: { email: added.email, sub: added.sub, credits: added.credits, plan: added.plan },
        poolSize: pool.list.length, active: pool.active,
        expIn: Math.round((auth.expMs - Date.now()) / 1000),
      });
    }

    if (u.pathname === '/healthz') {
      return send(res, 200, {
        ok: true, authSource: auth.source, hasToken: !!auth.token,
        expIn: Math.round((auth.expMs - Date.now()) / 1000), lastErr: auth.lastErr,
      });
    }

    /* ---- 单页可视化 ---- */
    if (u.pathname === '/api/credits') {
      const idx = parseInt(u.searchParams.get('idx') || String(pool.active), 10);
      const a = pool.list[idx];
      if (!a) return send(res, 404, { ok: false, err: 'no account' });
      if (!a.wsId) await refreshAccount(idx);
      const c = await fetchCredits(a.token, a.wsId);
      return send(res, 200, { ok: true, email: a.email, wsId: a.wsId, ...(c || {}) });
    }

    if (u.pathname === '/api/probe' && req.method === 'POST') {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      const force = body.force === true || u.searchParams.get('force') === '1';
      const ttlH = CFG.probe?.ttlHours ?? 24;
      const cacheFile = F('models_health.json');
      // 默认不重复花钱: 24h 内已有结果直接返回
      if (!force && fs.existsSync(cacheFile)) {
        try {
          const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          const ageH = (Date.now() - new Date(c.at).getTime()) / 3600e3;
          if (ageH < ttlH) {
            return send(res, 200, {
              ok: true, cached: true, ageHours: Math.round(ageH * 10) / 10, account: c.account,
              available: (c.results || []).filter((x) => x.ok).length, total: (c.results || []).length,
              results: c.results || [], note: '命中缓存, 未消耗积分; 要重新探测加 {"force":true}',
            });
          }
        } catch {}
      }
      let list = body.models || [];
      if (!Array.isArray(list) || !list.length) {
        const c = await loadCatalog().catch(() => catalog);
        list = (c.pub || []).map((m) => m.id);
      }
      const out = [];
      for (const model of list.slice(0, 60)) {
        const ai = pickAccount(model);
        if (ai < 0) { out.push({ model, ok: false, status: 0, ms: 0, err: '无账号允许该模型' }); continue; }
        const token = pool.list[ai].token;
        const t0 = Date.now();
        let rec = { model, ok: false, status: 0, ms: 0, err: '' };
        try {
          const r = await callGateway('/chat/completions', {
            model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1,
          }, { stream: false, token });
          rec.status = r.status;
          const txt = await r.text();
          if (r.status === 200) { rec.ok = true; }
          else {
            try { const j = JSON.parse(txt); rec.err = (j.error?.message || j.error?.code || txt).toString().slice(0, 140); }
            catch { rec.err = txt.slice(0, 140); }
          }
        } catch (e) { rec.err = e.message; }
        rec.ms = Date.now() - t0;
        rec.account = pool.list[ai]?.email || '';
        out.push(rec);
        log('[probe]', model, rec.status, rec.ok ? 'OK' : rec.err.slice(0, 60));
      }
      fs.writeFileSync(F('models_health.json'), JSON.stringify({ at: new Date().toISOString(), results: out }, null, 2));
      return send(res, 200, {
        ok: true,
        total: out.length, available: out.filter((x) => x.ok).length,
        results: out,
      });
    }

    if (u.pathname === '/api/accounts') {
      if (u.searchParams.get('refresh') === '1') await refreshAllAccounts();
      const list = pool.list.map((a, i) => ({
        idx: i, email: a.email, sub: a.sub, plan: a.plan,
        credits: a.credits, threshold: a.threshold,
        models: a.models || null,
        note: a.note || '',
        exp: (() => { const p = decodeJwt(a.token); return p.exp ? new Date(p.exp * 1000).toISOString() : null; })(),
        expHours: (() => { const p = decodeJwt(a.token); return p.exp ? Math.round((p.exp * 1000 - Date.now()) / 36e5 * 10) / 10 : null; })(),
        ready: accountReady(a) && accountAllows(a, null),
        active: i === pool.active,
        cooldown: a.cooldownUntil && a.cooldownUntil > Date.now()
          ? Math.round((a.cooldownUntil - Date.now()) / 1000) : 0,
        err: a.lastErr || '',
      }));
      return send(res, 200, { active: pool.active, count: list.length, accounts: list });
    }

    if (u.pathname === '/api/account/update' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
      const i = parseInt(b.idx, 10);
      if (!(i >= 0 && i < pool.list.length)) return send(res, 400, { ok: false, err: 'bad idx' });
      const a = pool.list[i];
      if (Array.isArray(b.models)) a.models = b.models.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
      if (typeof b.note === 'string') a.note = b.note.slice(0, 120);
      if (b.clearCooldown) a.cooldownUntil = 0;
      if (typeof b.credits === 'number') a.credits = b.credits;
      savePool();
      log('[pool] update', a.email, '| allowlist =', JSON.stringify(a.models || null));
      return send(res, 200, { ok: true, account: { idx: i, email: a.email, models: a.models || null, note: a.note || '' } });
    }

    if (u.pathname === '/api/switch' && req.method === 'POST') {
      let i = -1; try { i = parseInt(JSON.parse(raw || '{}').idx, 10); } catch {}
      if (!(i >= 0 && i < pool.list.length)) return send(res, 400, { ok: false, err: 'bad idx' });
      pool.active = i; pool.list[i].cooldownUntil = 0; savePool(); syncJwtFile();
      wsCache.clear();
      return send(res, 200, { ok: true, active: i, email: pool.list[i].email });
    }

    if (u.pathname === '/api/remove' && req.method === 'POST') {
      let i = -1; try { i = parseInt(JSON.parse(raw || '{}').idx, 10); } catch {}
      if (!(i >= 0 && i < pool.list.length)) return send(res, 400, { ok: false, err: 'bad idx' });
      const gone = pool.list.splice(i, 1)[0];
      if (pool.active >= pool.list.length) pool.active = Math.max(0, pool.list.length - 1);
      savePool(); syncJwtFile();
      log('[pool] removed', gone?.email);
      return send(res, 200, { ok: true, removed: gone?.email, count: pool.list.length });
    }

    if (u.pathname === '/api/cache-report') {
      const c = await loadCatalog().catch(() => catalog);
      const stats = new Map();
      for (const r of usageLog) {
        const k = r.model;
        const o = stats.get(k) || { calls: 0, prompt: 0, cached: 0 };
        o.calls++; o.prompt += r.prompt; o.cached += r.cached;
        stats.set(k, o);
      }
      const rows = (c.cap || []).filter((m) => m.type === 'LLM').map((m) => {
        const proto = m.protocol || 'openai_chat_completions';
        const policy = CFG.cache?.enabled === false ? 'off'
          : proto === 'anthropic_messages' ? 'cache_control(自动断点)'
          : String(proto).includes('gemini') ? 'implicit-prefix(稳定前缀)'
          : 'auto-prefix(prompt_cache_key + 24h)';
        const st = stats.get(m.id) || stats.get(m.id.split('/').pop()) || null;
        return {
          model: m.id,
          protocol: proto,
          policy,
          calls: st?.calls || 0,
          cacheRate: st && st.prompt ? Math.round((st.cached / st.prompt) * 1000) / 10 : null,
        };
      });
      return send(res, 200, { ok: true, rows });
    }

    if (u.pathname === '/api/usage') {
      const sum = usageLog.reduce((a, r) => {
        a.prompt += r.prompt; a.cached += r.cached; a.completion += r.completion; a.calls += 1;
        a.credits += r.estCredits || 0; return a;
      }, { prompt: 0, cached: 0, completion: 0, calls: 0, credits: 0 });
      return send(res, 200, {
        totals: { ...sum, credits: Math.round(sum.credits * 1000) / 1000, cacheRate: sum.prompt ? Math.round((sum.cached / sum.prompt) * 1000) / 10 : 0 },
        last: usageLog.slice(-20).reverse(),
      });
    }

    if (u.pathname === '/' || u.pathname === '/ui' || u.pathname === '/index.html') {
      try {
        const html = fs.readFileSync(F('ui.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      } catch (e) {
        return send(res, 500, { ok: false, err: 'ui.html 缺失: ' + e.message });
      }
    }

    if (u.pathname === '/api/status') {
      let ws = null;
      try {
        const token = await getToken();
        const r = await fetch(GATEWAY + '/workspaces', {
          headers: { 'Authorization': 'Bearer ' + token, 'Origin': ORIGIN, 'Accept': 'application/json' },
        });
        const j = await r.json();
        const w = j?.data?.workspaces?.[0];
        if (w) ws = {
          id: String(w.id), name: w.name, plan: w.plan_type,
          credits: w?.credits_balance?.total,
          breakdown: w?.credits_balance?.breakdown || null,
          creditsStatus: w?.credits_balance?.status,
          threshold: w?.credits_balance?.low_credits_threshold,
          aiStatus: w?.enter_ai_credits_status,
          dailyCredits: w?.entitlement?.daily_credits,
          models: w?.entitlement?.ai_all_models || [],
        };
      } catch (e) { ws = { error: e.message }; }

      const c = await loadCatalog().catch(() => catalog);
      const entitled = new Set(ws?.models || []);
      const price = (m) => {
        const p = m.sku_prices || {};
        return {
          in: p.input_token?.price_per_k_credits ?? null,
          out: p.output_token?.price_per_k_credits ?? null,
          cacheRead: p.cache_read_token?.price_per_k_credits ?? null,
        };
      };
      // 全站能力目录: 带 type / 授权标记 / 单价
      const matrix = (c.cap || []).map((m) => ({
        id: m.id, name: m.name, type: m.type, protocol: m.protocol || '',
        entitled: entitled.has(m.id), price: price(m),
      }));
      // 网关路由池（短 ID）
      const pool = (c.pub || []).map((m) => ({ id: m.id, name: m.name }));
      // 账号真正可对话的模型
      const chat = matrix.filter((m) => m.entitled && m.type === 'LLM')
        .sort((a, b) => (a.price.out ?? 9e9) - (b.price.out ?? 9e9));

      return send(res, 200, {
        ok: !!auth.token,
        auth: { source: auth.source, expIn: Math.round((auth.expMs - Date.now()) / 1000) },
        workspace: ws,
        lowCredits: ws?.credits != null && ws?.threshold != null ? ws.credits < ws.threshold : false,
        chat,
        pool,
        matrix,
      });
    }

    /* 页面里的工具执行（受限沙箱目录） */
    if (u.pathname === '/exec-tool' && req.method === 'POST') {
      let a = {}; try { a = JSON.parse(raw || '{}'); } catch {}
      const name = String(a.name || '');
      const args = a.args && typeof a.args === 'object' ? a.args : a;
      const root = path.resolve(CFG.toolRoot || process.cwd());
      const safe = (p) => {
        const abs = path.resolve(root, String(p || '.'));
        if (!abs.startsWith(root)) throw new Error('路径越界: ' + abs);
        return abs;
      };
      try {
        if (name === 'read_file') {
          const abs = safe(args.path);
          const st = fs.statSync(abs);
          if (st.size > 256 * 1024) throw new Error('文件过大: ' + st.size);
          return send(res, 200, { ok: true, name, path: abs, content: fs.readFileSync(abs, 'utf8') });
        }
        if (name === 'list_dir') {
          const abs = safe(args.path || '.');
          const items = fs.readdirSync(abs, { withFileTypes: true })
            .slice(0, 200)
            .map((d) => (d.isDirectory() ? d.name + '/' : d.name));
          return send(res, 200, { ok: true, name, path: abs, content: items.join('\n') });
        }
        return send(res, 200, { ok: false, name, content: '未实现的工具: ' + name });
      } catch (e) {
        return send(res, 200, { ok: false, name, content: '工具执行失败: ' + e.message });
      }
    }
    if (u.pathname === '/v1/models' || u.pathname === '/models') return handleModels(res);
    if (u.pathname === '/v1/chat/completions' || u.pathname === '/chat/completions') return handleChat(req, res, raw);
    if (u.pathname === '/v1/messages' || u.pathname === '/messages') return handleMessages(req, res, raw);
    if (u.pathname === '/v1/responses' || u.pathname === '/responses') {
      let token = await getToken().catch(() => '');
      let up = await callGateway('/responses', JSON.parse(raw || '{}'), { stream: false, token });
      if (up.status === 401) { token = await getToken(true).catch(() => ''); up = await callGateway('/responses', JSON.parse(raw || '{}'), { stream: false, token }); }
      const t = await up.text();
      res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(t);
    }
    send(res, 404, OPENAI_ERR('not found', 'not_found', 404));
  } catch (e) {
    log('[err]', e.stack || e.message);
    send(res, 500, OPENAI_ERR(e.message));
  }
});

authBoot().then(async () => {
  await loadCatalog().catch(() => {});
  // 回填历史用量的花费（之前目录未加载导致 estCredits 为 null/0）
  let changed = 0;
  for (const r of usageLog) {
    const c = estCredits(r.model, r.prompt, r.cached, r.completion);
    if (c != null && r.estCredits !== c) { r.estCredits = c; changed++; }
  }
  if (changed) {
    try { fs.writeFileSync(F('usage.jsonl'), usageLog.map((r) => JSON.stringify(r)).join('\n') + '\n'); } catch {}
    log('[usage] 回填花费记录', changed, '条');
  }
  server.listen(PORT, '127.0.0.1', () => {
    log(`bridge up: http://127.0.0.1:${PORT}/v1  ->  ${GATEWAY}`);
    log('auth:', auth.source || 'NONE', auth.token ? '(token ok)' : '(no token)');
  });
  // 定时续期: cookie 模式每 20 分钟; jwt 模式快过期前刷新
  setInterval(() => {
    getToken().catch((e) => log('[auth] tick:', e.message));
  }, 20 * 60e3);
});
