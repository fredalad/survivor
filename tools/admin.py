"""Owner-side admin for the paid survivor sheet. Needs firebase-admin and a service-account key:

  pip install firebase-admin
  set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
     (Firebase console > Project settings > Service accounts > Generate new private key)

  python tools/admin.py claim-board --board FcNiUIfqtOT6tBjo --email you@x.com --name "Nick's sheet"
        make an existing (pre-paywall) board owned by a user; the user must have signed in once
  python tools/admin.py grant-paths --email friend@x.com --n 2 [--seats 3]
        comp someone paths (and their board, if they have none) without going through Stripe
  python tools/admin.py add-seats --email you@x.com --n 2
  python tools/admin.py refund-check --board ID
        how many picks exist on the board, plus the purchase record; use before refunding in Stripe
  python tools/admin.py list-boards
"""
import argparse, json, os, secrets, time

import firebase_admin
from firebase_admin import auth, credentials, db

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cfg = json.load(open(os.path.join(ROOT, "firebase-config.json"), encoding="utf-8"))
firebase_admin.initialize_app(credentials.ApplicationDefault(), {"databaseURL": cfg["databaseURL"]})


def user_for(email):
    try:
        return auth.get_user_by_email(email)
    except auth.UserNotFoundError:
        raise SystemExit("%s has never signed in. Have them sign in once, then rerun." % email)


def make_board(uid, email, name, seats, board=None):
    board = board or secrets.token_urlsafe(9)
    now = int(time.time() * 1000)
    db.reference().update({
        "boards/%s/meta" % board: {"name": name, "owner": uid, "ownerEmail": email, "created": now},
        "users/%s/boards/%s" % (uid, board): True,
        "users/%s/email" % uid: email,
    })
    if seats:
        db.reference("users/%s/seats" % uid).transaction(lambda v: (v or 0) + seats)
    return board


def cmd_claim(a):
    u = user_for(a.email)
    meta = db.reference("boards/%s/meta" % a.board).get()
    if meta and meta.get("owner") and not a.force:
        raise SystemExit("board already owned by %s (use --force to overwrite)" % meta.get("ownerEmail", meta["owner"]))
    make_board(u.uid, a.email, a.name or (meta or {}).get("name") or "My sheet", a.seats, board=a.board)
    print("board", a.board, "now owned by", a.email)


def cmd_grant(a):
    u = user_for(a.email)
    boards = db.reference("users/%s/boards" % u.uid).get() or {}
    b = next(iter(boards), None) or make_board(u.uid, a.email, "My sheet", a.seats)
    now = int(time.time() * 1000)
    for _ in range(a.n):
        db.reference("users/%s/slots" % u.uid).child("p" + secrets.token_hex(4)).set({"at": now, "purchase": "comp"})
    print("board", b, "for", a.email, "+", a.n, "paths", ("+ %d seats" % a.seats) if a.seats else "")


def cmd_seats(a):
    u = user_for(a.email)
    ref = db.reference("users/%s/seats" % u.uid)
    new = ref.transaction(lambda v: (v or 0) + a.n)
    print(a.email, "seats now", new)


def cmd_refund(a):
    paths = db.reference("boards/%s/paths" % a.board).get() or {}
    picks = sum(len(p.get("picks") or {}) for p in paths.values())
    meta = db.reference("boards/%s/meta" % a.board).get() or {}
    print("board", a.board, "owner", meta.get("ownerEmail"), "created", time.strftime("%Y-%m-%d", time.gmtime((meta.get("created") or 0) / 1000)))
    for pid, pth in paths.items():
        print("  path", pid, "|", pth.get("name"), "| picks:", len(pth.get("picks") or {}), "->", "refundable if within 7 days" if not pth.get("picks") else "NOT refundable")
    for sid, p in (db.reference("purchases").get() or {}).items():
        if p.get("boardId") == a.board or a.board in (p.get("boards") or []):
            print("purchase", sid, p.get("kind"), "qty", p.get("qty"), "amount", (p.get("amount") or 0) / 100, p.get("currency"))


def cmd_list(a):
    for b, v in (db.reference("boards").get() or {}).items():
        m = v.get("meta") or {}
        print(b, "|", m.get("name"), "|", m.get("ownerEmail"), "| paths", len(v.get("paths") or {}))


ap = argparse.ArgumentParser()
sub = ap.add_subparsers(dest="cmd", required=True)
p = sub.add_parser("claim-board"); p.add_argument("--board", required=True); p.add_argument("--email", required=True); p.add_argument("--name"); p.add_argument("--seats", type=int, default=0); p.add_argument("--force", action="store_true"); p.set_defaults(f=cmd_claim)
p = sub.add_parser("grant-paths"); p.add_argument("--email", required=True); p.add_argument("--n", type=int, default=1); p.add_argument("--seats", type=int, default=0); p.set_defaults(f=cmd_grant)
p = sub.add_parser("add-seats"); p.add_argument("--email", required=True); p.add_argument("--n", type=int, required=True); p.set_defaults(f=cmd_seats)
p = sub.add_parser("refund-check"); p.add_argument("--board", required=True); p.set_defaults(f=cmd_refund)
p = sub.add_parser("list-boards"); p.set_defaults(f=cmd_list)
a = ap.parse_args(); a.f(a)
