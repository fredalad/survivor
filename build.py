"""Build index.html from src/template.html + data. Run: python build.py"""
import json, os, secrets
here = os.path.dirname(os.path.abspath(__file__))
def rd(p): return open(os.path.join(here, p), encoding="utf-8").read()
cfg_path = os.path.join(here, "firebase-config.json")
cfg = rd("firebase-config.json").strip() if os.path.exists(cfg_path) else "null"
board_path = os.path.join(here, "board-id.txt")
if not os.path.exists(board_path):
    open(board_path, "w").write(secrets.token_urlsafe(12))
board = rd("board-id.txt").strip()
html = (rd("src/template.html")
        .replace("__GAMES__", rd("src/games.json").strip())
        .replace("__NAMES__", rd("src/names.json").strip())
        .replace("__FIREBASE_CONFIG__", cfg)
        .replace("__BOARD_ID__", board)
        .replace("__STATIC_PATHS__", json.dumps([{"id": "optimal", "name": "Optimal default", "color": "#5F6976", "order": -1,
                                                  "picks": json.loads(rd("src/optimal.json"))}])))
open(os.path.join(here, "index.html"), "w", encoding="utf-8").write(html)
print("wrote index.html", len(html), "bytes; firebase:", "configured" if cfg != "null" else "not configured")
