"""CK 续期器（Python + Playwright，复用已安装的 chromium）

    python renew.py --check     查看各号 token 剩余时间（不消耗积分）
    python renew.py --login     可见浏览器登录一次（首次必须做）
    python renew.py             无头续期：打开页面 → /auth/session?include=access_token → 推入账号池

续期原理：Auth0 的 refresh_token 在服务端，前端拿不到；
唯一可行路径是用浏览器的登录态会话调用 BFF 重新签发 access_token。
所以需要一个「登录过一次」的浏览器配置目录（renew-profile/）。
"""
import json
from pathlib import Path
import sys
import time
import urllib.request
from datetime import datetime, timezone

HERE = str(Path(__file__).resolve().parent)
CFG = json.load(open(HERE + r"\config.json", encoding="utf-8"))
PORT = CFG.get("port", 8097)
ORIGIN = CFG.get("origin", "https://enter.converge.ai")
PROFILE_NAME = sys.argv[sys.argv.index("--profile") + 1] if "--profile" in sys.argv else "default"
PROFILE = HERE + r"\renew-profile-" + PROFILE_NAME

LOGIN = "--login" in sys.argv
CHECK = "--check" in sys.argv


def api(path, payload=None):
    url = f"http://127.0.0.1:{PORT}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "{}")


def decode(tok):
    import base64
    try:
        p = tok.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception:
        return {}


def check():
    j = api("/api/accounts")
    print("账号池:", j.get("count"), "个")
    for a in j.get("accounts", []):
        h = a.get("expHours")
        print(f" {a['idx']} {str(a.get('email'))[:36]:36} credits={str(a.get('credits')):6} "
              f"剩余={str(h):6}h  {a.get('exp') or ''}")


def push(token):
    p = decode(token)
    out = api("/ingest-token", {"token": token})
    left = (p.get("exp", 0) * 1000 - datetime.now(timezone.utc).timestamp() * 1000) / 3600e3
    print("已推入账号池:", json.dumps({
        "ok": out.get("ok"), "email": out.get("account", {}).get("email"),
        "credits": out.get("account", {}).get("credits"), "poolSize": out.get("poolSize"),
    }, ensure_ascii=False))
    print("新 token exp:", datetime.fromtimestamp(p.get("exp", 0), tz=timezone.utc).isoformat(),
          f"(剩 {left:.1f} h)")


def grab(page):
    return page.evaluate("""async () => {
        try {
            const r = await fetch('/auth/session?include=access_token', { credentials: 'include' });
            const t = await r.text();
            return [r.status, t];
        } catch (e) { return [0, String(e)]; }
    }""")


def main():
    if CHECK:
        return check()

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=not LOGIN,
            viewport={"width": 1280, "height": 820},
            locale="en-US",
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=90000)

        if LOGIN:
            print("浏览器已打开，请在窗口里完成登录；登录成功后会自动抓取并写入账号池…")
            t0 = time.time()
            while time.time() - t0 < 600:
                time.sleep(3)
                code, body = grab(page)
                if code == 200 and "accessToken" in body:
                    print("登录成功，抓到 token")
                    push(json.loads(body)["accessToken"])
                    ctx.close()
                    return
            print("等待登录超时（10 分钟）")
            ctx.close()
            sys.exit(3)

        time.sleep(4)
        code, body = grab(page)
        if code != 200 or "accessToken" not in body:
            print("续期失败，状态:", code)
            print("响应片段:", str(body)[:200])
            print("→ 会话不存在或被 Cloudflare 拦，先跑一次: python renew.py --login")
            ctx.close()
            sys.exit(3)
        push(json.loads(body)["accessToken"])
        ctx.close()


if __name__ == "__main__":
    main()
