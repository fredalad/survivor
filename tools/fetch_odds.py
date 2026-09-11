"""Pull the 2026 NFL schedule and DraftKings lines from ESPN's public scoreboard.

  python tools/fetch_odds.py                 refresh src/games.json (the fallback lines baked into the page)
  python tools/fetch_odds.py --out odds.json  also write the live-odds document (same shape the scheduled
                                             Cloud Function writes to odds/2026 in the Realtime Database)
  python tools/fetch_odds.py --push           write that document to the database with firebase-admin
                                             (pip install firebase-admin; GOOGLE_APPLICATION_CREDENTIALS must
                                             point at a service-account key for the Firebase project)
  python tools/fetch_odds.py --weeks 2,3      limit to some weeks (default: all 18)

Row shape used by the page and by src/games.json:
  [week, date, day, time(ET or "TBD"), away, home, spread(home-relative), mlAway, mlHome, total, neutral]
"""
import argparse, datetime as dt, json, os, sys, time, urllib.request

SEASON = 2026
ESPN = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
        "?week={w}&seasontype=2&dates=%d" % SEASON)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GAMES_JSON = os.path.join(ROOT, "src", "games.json")


def eastern(iso):
    """ESPN gives UTC like 2026-09-10T00:20Z. Return (date, day, time) in US Eastern, DST by the US rule."""
    u = dt.datetime.strptime(iso, "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc)
    y = u.year

    def nth_sunday(month, n):
        d = dt.date(y, month, 1)
        d += dt.timedelta(days=(6 - d.weekday()) % 7)
        return d + dt.timedelta(weeks=n - 1)

    start = dt.datetime.combine(nth_sunday(3, 2), dt.time(7), dt.timezone.utc)   # 2 am EST = 07:00Z
    end = dt.datetime.combine(nth_sunday(11, 1), dt.time(6), dt.timezone.utc)    # 2 am EDT = 06:00Z
    e = u + dt.timedelta(hours=-4 if start <= u < end else -5)
    return e.strftime("%Y-%m-%d"), e.strftime("%a"), e.strftime("%I:%M %p").lstrip("0")


def moneyline(s):
    if s is None:
        return None
    s = str(s).strip().upper()
    if s in ("EVEN", "PK", "+100"):
        return 100
    try:
        return int(s.replace("+", ""))
    except ValueError:
        return None


def parse_event(e, w):
    c = e["competitions"][0]
    side = {x["homeAway"]: x for x in c["competitors"]}
    away, home = side["away"]["team"]["abbreviation"], side["home"]["team"]["abbreviation"]
    date, day, tm = eastern(e["date"])
    if not c.get("timeValid", True):
        tm = "TBD"
    o = (c.get("odds") or [None])[0] or {}
    spread = o.get("spread")
    ps = (((o.get("pointSpread") or {}).get("home") or {}).get("close") or {}).get("line")
    if ps not in (None, ""):
        try:
            spread = float(ps)
        except ValueError:
            pass
    ml = o.get("moneyline") or {}
    st = c["status"]["type"]
    return {
        "w": w, "date": date, "day": day, "time": tm, "away": away, "home": home,
        "spread": spread,
        "mlAway": moneyline(((ml.get("away") or {}).get("close") or {}).get("odds")),
        "mlHome": moneyline(((ml.get("home") or {}).get("close") or {}).get("odds")),
        "ou": o.get("overUnder"),
        "neutral": 1 if c.get("neutralSite") else 0,
        "status": st.get("state", "pre"), "done": bool(st.get("completed")),
        "as": int(side["away"].get("score") or 0), "hs": int(side["home"].get("score") or 0),
        "book": (o.get("provider") or {}).get("name"),
    }


def fetch(weeks):
    games = []
    for w in weeks:
        req = urllib.request.Request(ESPN.format(w=w))  # ESPN rejects custom user-agents; the default works
        d = json.loads(urllib.request.urlopen(req, timeout=20).read())
        games += [parse_event(e, w) for e in d.get("events", [])]
        time.sleep(0.15)
    return games


def key(g):
    return "%d_%s_%s" % (g["w"], g["away"], g["home"])


def to_row(g, old=None):
    """Fallback to the previously baked value for anything ESPN left blank."""
    def pick(new, idx):
        return new if new is not None else (old[idx] if old else None)
    return [g["w"], g["date"], g["day"], g["time"], g["away"], g["home"],
            pick(g["spread"], 6), pick(g["mlAway"], 7), pick(g["mlHome"], 8), pick(g["ou"], 9), g["neutral"]]


def live_doc(games):
    return {"meta": {"updated": int(time.time() * 1000), "source": "DraftKings via ESPN", "season": SEASON,
                     "weeks": sorted({g["w"] for g in games})},
            "games": {key(g): g for g in games}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", default="")
    ap.add_argument("--out")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--no-bake", action="store_true", help="do not rewrite src/games.json")
    a = ap.parse_args()
    weeks = [int(x) for x in a.weeks.split(",") if x] or list(range(1, 19))
    games = fetch(weeks)
    print("fetched", len(games), "games for weeks", weeks[0], "-", weeks[-1])

    if not a.no_bake:
        old = {}
        if os.path.exists(GAMES_JSON):
            for r in json.load(open(GAMES_JSON, encoding="utf-8")):
                old["%d_%s_%s" % (r[0], r[4], r[5])] = r
        merged = dict(old)
        for g in games:
            merged[key(g)] = to_row(g, old.get(key(g)))
        rows = sorted(merged.values(), key=lambda r: (r[0], r[1], r[3] == "TBD", r[3]))
        missing = [r for r in rows if r[7] is None or r[8] is None]
        json.dump(rows, open(GAMES_JSON, "w", encoding="utf-8"), separators=(",", ":"))
        print("wrote", GAMES_JSON, len(rows), "rows;", len(missing), "without a moneyline")

    doc = live_doc(games)
    if a.out:
        json.dump(doc, open(a.out, "w", encoding="utf-8"))
        print("wrote", a.out)
    if a.push:
        import firebase_admin
        from firebase_admin import credentials, db
        cfg = json.load(open(os.path.join(ROOT, "firebase-config.json"), encoding="utf-8"))
        firebase_admin.initialize_app(credentials.ApplicationDefault(), {"databaseURL": cfg["databaseURL"]})
        ref = db.reference("odds/%d" % SEASON)
        ref.child("games").update(doc["games"])
        ref.child("meta").set(doc["meta"])
        print("pushed to odds/%d" % SEASON)


if __name__ == "__main__":
    main()
