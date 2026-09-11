"""Build public/index.html and public/terms.html from src/ + data. Run: python build.py

Refresh the fallback lines baked into the page first with: python tools/fetch_odds.py
Deploy with: firebase deploy
"""
import json, os, time

here = os.path.dirname(os.path.abspath(__file__))


def rd(p):
    return open(os.path.join(here, p), encoding="utf-8").read()


def exists(p):
    return os.path.exists(os.path.join(here, p))


cfg = rd("firebase-config.json").strip() if exists("firebase-config.json") else "null"
app = {"name": "Survivor Sheet", "tagline": "Pick planner for the Circa Survivor contest",
       "priceSheet": 10, "priceSeats": 5, "supportEmail": "support@example.com", "season": 2026}
if exists("app-config.json"):
    app.update(json.loads(rd("app-config.json")))

static_paths = [{"id": "optimal", "name": "Optimal default", "color": "#5F6976", "order": -1,
                 "picks": json.loads(rd("src/optimal.json"))}]

html = (rd("src/template.html")
        .replace("__GAMES__", rd("src/games.json").strip())
        .replace("__NAMES__", rd("src/names.json").strip())
        .replace("__FIREBASE_CONFIG__", cfg)
        .replace("__APP_CONFIG__", json.dumps(app))
        .replace("__BUILT_AT__", str(int(time.time() * 1000)))
        .replace("__STATIC_PATHS__", json.dumps(static_paths)))

def fill(tpl):
    return (tpl.replace("__APP_NAME__", app["name"])
               .replace("__SUPPORT_EMAIL__", app["supportEmail"])
               .replace("__PRICE_SHEET__", str(app["priceSheet"]))
               .replace("__PRICE_SEATS__", str(app["priceSeats"])))


faq = fill(rd("src/faq.html"))
legal = (rd("src/legal.html")
         .replace("__APP_NAME__", app["name"])
         .replace("__SUPPORT_EMAIL__", app["supportEmail"])
         .replace("__PRICE_SHEET__", str(app["priceSheet"]))
         .replace("__PRICE_SEATS__", str(app["priceSeats"])))

os.makedirs(os.path.join(here, "public"), exist_ok=True)
open(os.path.join(here, "public", "index.html"), "w", encoding="utf-8").write(html)
open(os.path.join(here, "public", "terms.html"), "w", encoding="utf-8").write(legal)
open(os.path.join(here, "public", "faq.html"), "w", encoding="utf-8").write(faq)
print("wrote public/index.html", len(html), "bytes, public/terms.html, public/faq.html; firebase:",
      "configured" if cfg != "null" else "not configured")
