"""CK 注入续期：把抓下来的 cookies 灌进独立浏览器配置目录，再让页面自己换新 token。

    python renew-cookie.py --file ck_alex_han53.json           无头尝试
    python renew-cookie.py --file ck_alex_han53.json --headed   有头（CF 拦时用）
    python renew-cookie.py --file ck_alex_han53.json --push     成功后推入账号池

cookies 里的关键项：
  appSession.0/1   ← BFF 会话（真正决定登录态）
  converge_session ← 站点会话
  cf_clearance     ← Cloudflare 通行证，绑定 UA+IP，过期很快
"""
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
PORT = CFG.get("port", 8097)
ORIGIN = CFG.get("origin", "https://enter.converge.ai")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

args = sys.argv[1:]
FILE = args[args.index("--file") + 1] if "--file" in args else ""
HEADED = "--headed" in args
PUSH = "--push" in args


def load_accounts(path):
    p = Path(path)
    if not p.is_absolute():
        p = HERE.parent / path
    data = json.loads(p.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else [data]


def push_token(token, email=""):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/ingest-token",
        data=json.dumps({"token": token}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read().decode())
    print("   已入池:", out.get("ok"), "|", (out.get("account") or {}).get("email"),
          "| credits:", (out.get("account") or {}).get("credits"))


def seed_one(acc):
    from playwright.sync_api import sync_playwright

    email = acc.get("email") or "unknown"
    tag = email.split("@")[0].replace(".", "_")
    cookies_raw = [c for c in (acc.get("cookies") or [])
                   if "converge.ai" in c.get("domain", "")
                   and not c.get("name", "").startswith(("cf_", "__cf", "_gcl", "mp_", "_dd_s"))]
    if not cookies_raw:
        print(f"  {email:26} 无 cookie，跳过")
        return None

    profile = HERE / f"seed-profile-{tag}"
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(profile),
            headless=not HEADED,
            viewport={"width": 1200, "height": 760},
            locale="en-US",
            args=["--disable-blink-features=AutomationControlled"],
        )
        payload = []
        for c in cookies_raw:
            item = {
                "name": c["name"], "value": c["value"], "domain": c["domain"],
                "path": c.get("path", "/"),
                "httpOnly": bool(c.get("httpOnly", True)),
                "secure": bool(c.get("secure", True)),
                "sameSite": c.get("sameSite") or "Lax",
            }
            if c.get("expires"):
                item["expires"] = float(c["expires"])
            payload.append(item)
        try:
            ctx.add_cookies(payload)
        except Exception as e:
            print(f"  {email:26} add_cookies 警告: {str(e)[:100]}")

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=90000)
        except Exception as e:
            print(f"  {email:26} 打开页面失败: {str(e)[:80]}")

        # 等 Cloudflare challenge 放行
        cleared = False
        for _ in range(30):
            time.sleep(1.5)
            try:
                title = page.title() or ""
            except Exception:
                title = ""
            if "just a moment" not in title.lower() and "attention required" not in title.lower():
                cleared = True
                break
        if not cleared:
            print(f"  {email:26} Cloudflare 未放行（title 仍是 challenge）")

        r = page.evaluate("""async () => {
            try { const r = await fetch('/auth/session?include=access_token', { credentials: 'include' });
                  const t = await r.text(); return [r.status, t]; }
            catch (e) { return [0, String(e)]; }
        }""")
        code, body = r
        tok = ""
        try:
            tok = json.loads(body).get("accessToken", "")
        except Exception:
            pass

        if tok:
            print(f"  {email:26} 状态={code} [OK] 拿到 token ({len(tok)} 字符)")
            if PUSH:
                push_token(tok, email)
        else:
            print(f"  {email:26} 状态={code} [FAIL] {str(body)[:100]}")
        ctx.close()
        return tok


def main():
    if not FILE:
        print("用法: python renew-cookie.py --file ck_alex_han53.json [--headed] [--push]")
        print("可选文件: ck_alex_han53.json / ck_ivy_jiang66.json / ck_mqian.json")
        return
    accounts = load_accounts(FILE)
    print(f"载入 {len(accounts)} 个账号，模式={'有头' if HEADED else '无头'}，push={PUSH}")
    for acc in accounts:
        try:
            seed_one(acc)
        except Exception as e:
            print("  失败:", str(e)[:160])


if __name__ == "__main__":
    main()
