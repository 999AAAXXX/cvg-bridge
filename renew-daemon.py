"""CK 续期守护：常驻一个可见 Chromium（最小化即可），定时把新 token 推进账号池。
Cloudflare 对无头浏览器会出 challenge，所以用真实窗口常驻；窗口可以最小化，不要关闭。

    python renew-daemon.py                 每 6 小时续一次（默认）
    python renew-daemon.py --every 120     每 120 分钟续一次
    python renew-daemon.py --once          只续一次然后退出（等同 renew.py）
"""
import json
from pathlib import Path
import sys
import time
from datetime import datetime, timezone

HERE = str(Path(__file__).resolve().parent)
CFG = json.load(open(HERE + r"\config.json", encoding="utf-8"))
PORT = CFG.get("port", 8097)
ORIGIN = CFG.get("origin", "https://enter.converge.ai")
PROFILE_NAME = sys.argv[sys.argv.index("--profile") + 1] if "--profile" in sys.argv else "default"
PROFILE = HERE + r"\renew-profile-" + PROFILE_NAME

EVERY = 360
SINGLE = "--once" in sys.argv
if "--every" in sys.argv:
    EVERY = int(sys.argv[sys.argv.index("--every") + 1])


def push(token):
    import urllib.request
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/ingest-token",
        data=json.dumps({"token": token}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def main():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1200, "height": 760}, locale="en-US",
            args=["--disable-blink-features=AutomationControlled", "--start-minimized"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        log("浏览器已启动，保持这个窗口不要关（可最小化）")
        try:
            page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=90000)
        except Exception as e:
            log("首次打开失败:", e)

        while True:
            try:
                if page.url == "about:blank" or not page.url.startswith(ORIGIN):
                    page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=90000)
                r = page.evaluate("""async () => {
                    try { const r = await fetch('/auth/session?include=access_token', { credentials: 'include' });
                          const t = await r.text(); return [r.status, t]; }
                    catch (e) { return [0, String(e)]; }
                }""")
                code, body = r
                if code == 200 and "accessToken" in body:
                    j = json.loads(body)
                    tok = j["accessToken"]
                    p = json.loads(__import__("base64").urlsafe_b64decode(
                        tok.split(".")[1] + "=" * (-len(tok.split(".")[1]) % 4)).decode())
                    out = push(tok)
                    hrs = (p["exp"] * 1000 - datetime.now(timezone.utc).timestamp() * 1000) / 3600e3
                    log("续期成功:", out.get("account", {}).get("email"),
                        "| exp", datetime.fromtimestamp(p["exp"], tz=timezone.utc).strftime("%m-%d %H:%M UTC"),
                        f"(剩 {hrs:.1f}h)")
                else:
                    log("续期失败 code=", code, "| 可能未登录，请在这个窗口里登录一次")
                    if code == 403 or code == 0:
                        page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=90000)
            except Exception as e:
                log("异常:", e)

            if SINGLE:
                break
            time.sleep(EVERY * 60)

        ctx.close()


if __name__ == "__main__":
    main()
