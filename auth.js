/**
 * 鉴权助手
 *   node auth.js check             本地桥 + 上游鉴权连通性
 *   node auth.js jwt <access_token>  写入 jwt.txt 并校验
 *   node auth.js cookie <name=value> 写入 cookie.txt 并尝试换 token
 *   node auth.js sniff               用 cookie.txt 暴力探测 session cookie 名
 *   node auth.js whoami              查当前账号信息
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const GW = CFG.gateway.replace(/\/$/, '');
const OR = CFG.origin;
const UA = CFG.userAgent;
const F = (n) => path.join(ROOT, n);
const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };

const CANDIDATES = [
  'session', '__Secure-session', '__Host-session',
  'enter_session', '__Secure-enter_session', '__Host-enter_session',
  'enter-session', 'cvg_session', 'cvg-session', 'cvg_session_token',
  'authjs.session-token', '__Secure-authjs.session-token',
  'next-auth.session-token', '__Secure-next-auth.session-token',
  'enter.pro-session', 'enter_token', 'access_token', 'token', 'sid',
  'gateway_session', 'session-token', 'cvg_token', 'enter_session_token',
  'enter-auth', 'eauth', 'ES_SESSION', 'JSESSIONID', 'sso', 'sso_token',
  'enterpro', 'enter-pro-session', 'cvg-auth', '_cvg_session',
];

async function upstreamAuth(token) {
  const r = await fetch(GW + '/users/info', {
    headers: { 'Authorization': 'Bearer ' + token, 'Origin': OR, 'Accept': 'application/json', 'User-Agent': UA },
  });
  const t = await r.text();
  return { code: r.status, body: t.slice(0, 400) };
}

async function exchange(cookieHeader) {
  const cf = CFG.auth.cfClearance || read(F('cf_clearance.txt'));
  const r = await fetch(`${OR}/auth/session?include=access_token`, {
    headers: {
      'Cookie': cookieHeader, 'Accept': 'application/json', 'User-Agent': UA, 'Referer': OR + '/',
      ...(cf ? { 'cf_clearance': cf } : {}),
    },
  });
  const t = await r.text();
  if (r.status === 204) return { code: 204, body: 'no session' };
  return { code: r.status, body: t.slice(0, 500), json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');

  if (cmd === 'jwt') {
    fs.writeFileSync(F('jwt.txt'), arg.trim());
    const r = await upstreamAuth(arg.trim());
    console.log('saved jwt.txt; upstream /users/info ->', r.code, r.body);
    return;
  }

  if (cmd === 'cookie') {
    fs.writeFileSync(F('cookie.txt'), arg.trim());
    const r = await exchange(arg.trim());
    console.log('saved cookie.txt; session ->', r.code, typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    if (r.json) {
      const tok = r.json.accessToken || r.json.access_token || r.json.data?.accessToken;
      if (tok) {
        fs.writeFileSync(F('jwt.txt'), tok);
        console.log('access_token saved to jwt.txt');
        console.log('upstream ->', JSON.stringify(await upstreamAuth(tok)));
      }
    }
    return;
  }

  if (cmd === 'sniff') {
    const raw = arg.trim() || read(F('cookie.txt'));
    if (!raw) return console.log('用法: node auth.js sniff <cookieValue 或 name=value>');
    const bare = raw.includes('=') ? raw.split('=').slice(1).join('=') : raw;
    let hit = 0;
    for (const n of CANDIDATES) {
      const r = await exchange(`${n}=${bare}`).catch((e) => ({ code: 0, body: e.message }));
      const tag = r.code === 204 ? '   ' : ' >>';
      if (r.code !== 204) { hit++; console.log(tag, n.padEnd(34), r.code, (r.body || '').slice(0, 120)); }
      else if (process.env.VERBOSE) console.log(tag, n.padEnd(34), 204);
    }
    console.log(hit ? `\n命中 ${hit} 个候选名，用: node auth.js cookie "<name>=<value>"` : '\n全部 204: cookie 值失效 / 名字不在候选表 / 需要 cf_clearance');
    return;
  }

  if (cmd === 'whoami') {
    const tok = await pickToken();
    if (!tok) return console.log('没有可用 token');
    console.log(JSON.stringify(await upstreamAuth(tok)));
    return;
  }

  // check
  const tok = await pickToken();
  console.log('token source:', tok ? (read(F('jwt.txt')) ? 'jwt.txt' : 'cookie exchange') : 'NONE');
  if (tok) console.log('upstream /users/info ->', JSON.stringify(await upstreamAuth(tok)));
  try {
    const h = await fetch('http://127.0.0.1:' + (CFG.port || 8097) + '/healthz');
    console.log('bridge /healthz ->', h.status, (await h.text()).slice(0, 300));
  } catch (e) {
    console.log('bridge 未启动:', e.message);
  }

  async function pickToken() {
    const j = read(F('jwt.txt'));
    if (j && j.split('.').length === 3) return j;
    const c = read(F('cookie.txt'));
    if (c) {
      const r = await exchange(c.includes('=') ? c : `${CFG.auth.cookieName}=${c}`);
      if (r.json) return r.json.accessToken || r.json.access_token || '';
    }
    return '';
  }
})();
