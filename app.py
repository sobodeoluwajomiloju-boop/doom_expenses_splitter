"""DormSplit backend: Flask + SQLite (Optimized for local VS Code usage).

Everything is saved locally in dorm_split.db (next to this file), so registrations 
and expenses survive restarts.
"""
import json
import math
import os
import re
import sqlite3
import time
from collections import Counter

from flask import Flask, g, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
CORS(app)

MASTER_ADMIN_KEY = "1234"  # change this if you want a custom admin key
NUM_STUDENTS = 13
ROOM = "7"                 # everyone shares this room
MAX_FAILS = 5              # wrong PINs allowed before a short lock
LOCK_SECONDS = 60
DB_PATH = os.path.expanduser("~/dorm_split.db")
_fails = {}  # student_id -> [wrong_count, locked_until_timestamp]


# ---------------------------------------------------------------- database
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS students ("
        "id INTEGER PRIMARY KEY, name TEXT NOT NULL, room TEXT NOT NULL, pin_hash TEXT)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS expenses ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, amount REAL, "
        "paid_by TEXT, split_among TEXT, category TEXT, timestamp TEXT)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS cart_items ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL, "
        "quantity INTEGER NOT NULL, added_by INTEGER, checked INTEGER NOT NULL DEFAULT 0, "
        "created_at TEXT)"
    )
    for i in range(1, NUM_STUDENTS + 1):
        conn.execute(
            "INSERT OR IGNORE INTO students (id, name, room, pin_hash) VALUES (?, ?, ?, NULL)",
            (i, f"Student {i}", ROOM),
        )
    conn.execute("UPDATE students SET room = ?", (ROOM,))
    conn.commit()
    conn.close()


init_db()


# ----------------------------------------------------------------- helpers
def err(message, status):
    return jsonify({"status": "error", "message": message}), status


def parse_id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def get_student(sid):
    return db().execute("SELECT * FROM students WHERE id = ?", (sid,)).fetchone()


def public_student(row):
    """Never includes the PIN or its hash."""
    return {
        "id": row["id"],
        "name": row["name"],
        "room": row["room"],
        "registered": row["pin_hash"] is not None,
    }


def first_value(data, *keys):
    for key in keys:
        if data.get(key) not in (None, ""):
            return data[key]
    return None


def first_text(data, *keys):
    value = first_value(data, *keys)
    return str(value).strip()[:40] if value is not None else ""


def valid_pin(pin):
    return re.fullmatch(r"[0-9]{4}", pin) is not None


def hash_pin(pin):
    return generate_password_hash(pin, method="pbkdf2:sha256:50000")


def locked_seconds(sid):
    entry = _fails.get(sid)
    if entry and entry[1] > time.time():
        return int(entry[1] - time.time()) + 1
    return 0


def record_fail(sid):
    entry = _fails.setdefault(sid, [0, 0])
    if entry[1] and entry[1] <= time.time():
        entry[0], entry[1] = 0, 0
    entry[0] += 1
    if entry[0] >= MAX_FAILS:
        entry[1] = time.time() + LOCK_SECONDS
        entry[0] = 0


def clear_fails(sid):
    _fails.pop(sid, None)


def too_many(sid):
    return err(f"Too many wrong PINs. Try again in {locked_seconds(sid)} seconds.", 429)


def resolve_ref(ref, students):
    if isinstance(ref, dict):
        ref = ref.get("id", ref.get("name"))
    if isinstance(ref, float) and ref.is_integer():
        ref = int(ref)
    if ref is None or isinstance(ref, (bool, list, dict)):
        return None
    ids = {s["id"] for s in students}
    text = str(ref).strip().lower()
    if re.fullmatch(r"[0-9]+", text) and int(text) in ids:
        return int(text)
    match = re.fullmatch(r"(?:slot|s)[-_ ]?([0-9]+)", text)
    if match and int(match.group(1)) in ids:
        return int(match.group(1))
    for s in students:
        if s["name"].strip().lower() == text:
            return s["id"]
    return None


def expense_dict(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "amount": row["amount"],
        "paid_by": json.loads(row["paid_by"]),
        "split_among": json.loads(row["split_among"]),
        "category": row["category"],
        "timestamp": row["timestamp"],
    }


# -------------------------------------------------------------------- misc
@app.route("/", methods=["GET"])
def home():
    return jsonify({"status": "ok", "service": "DormSplit Local API"}), 200


@app.errorhandler(Exception)
def handle_error(error):
    if isinstance(error, HTTPException):
        return err(error.description, error.code)
    app.logger.exception(error)
    return err("Server error", 500)


# -------------------------------------------------------------------- auth
@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    sid = parse_id(data.get("student_id"))
    student = get_student(sid)
    if not student:
        return err("Student not found", 404)
    if student["pin_hash"] is None:
        return jsonify({"status": "needs_setup", "message": "First time setup required"}), 200
    pin = "" if data.get("pin") is None else str(data["pin"])
    if pin == "":
        return err("Incorrect PIN", 401)
    if locked_seconds(sid):
        return too_many(sid)
    if check_password_hash(student["pin_hash"], pin):
        clear_fails(sid)
        return jsonify({"status": "success", "user": public_student(student)}), 200
    record_fail(sid)
    return err("Incorrect PIN", 401)


@app.route("/api/auth/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    sid = parse_id(data.get("student_id"))
    student = get_student(sid)
    if not student:
        return err("Student not found", 404)
    if str(data.get("master_key", "")) != MASTER_ADMIN_KEY:
        return err("Invalid master key", 403)
    if student["pin_hash"] is not None:
        return err("Already registered", 409)
    name = first_text(data, "name", "display_name", "displayName")
    if not name:
        return err("Name is required", 400)
    pin = str(data.get("pin", ""))
    if not valid_pin(pin):
        return err("PIN must be 4 digits", 400)
    d = db()
    cur = d.execute(
        "UPDATE students SET name = ?, room = ?, pin_hash = ? WHERE id = ? AND pin_hash IS NULL",
        (name, ROOM, hash_pin(pin), sid),
    )
    d.commit()
    if cur.rowcount == 0:
        return err("Already registered", 409)
    return jsonify({"status": "success", "user": public_student(get_student(sid))}), 201


@app.route("/api/auth/set-pin", methods=["POST"])
def set_pin():
    data = request.get_json(silent=True) or {}
    sid = parse_id(data.get("student_id"))
    student = get_student(sid)
    if not student:
        return err("Student not found", 404)
    if student["pin_hash"] is None:
        return err("This slot is not registered yet.", 400)
    if str(data.get("master_key", "")) != MASTER_ADMIN_KEY:
        if locked_seconds(sid):
            return too_many(sid)
        current = str(first_value(data, "current_pin", "old_pin", "pin") or "")
        if not current or not check_password_hash(student["pin_hash"], current):
            if current:
                record_fail(sid)
            return err("Current PIN is incorrect", 401)
        clear_fails(sid)
    name = first_text(data, "name", "display_name", "displayName") or student["name"]
    pin_hash = student["pin_hash"]
    if data.get("new_pin") not in (None, ""):
        new_pin = str(data["new_pin"])
        if not valid_pin(new_pin):
            return err("PIN must be 4 digits", 400)
        pin_hash = hash_pin(new_pin)
    d = db()
    d.execute(
        "UPDATE students SET name = ?, room = ?, pin_hash = ? WHERE id = ?",
        (name, ROOM, pin_hash, sid),
    )
    d.commit()
    return jsonify({
        "status": "success",
        "message": "Saved successfully!",
        "user": public_student(get_student(sid)),
    }), 200


# --------------------------------------------------------------- roommates
@app.route("/api/roommates", methods=["GET"])
def get_roommates():
    rows = db().execute("SELECT * FROM students ORDER BY id").fetchall()
    return jsonify({"roommates": [public_student(r) for r in rows]}), 200


# ---------------------------------------------------------------- expenses
@app.route("/api/expenses", methods=["GET", "POST"])
def handle_expenses():
    d = db()
    if request.method == "GET":
        rows = d.execute("SELECT * FROM expenses ORDER BY id").fetchall()
        return jsonify({"expenses": [expense_dict(r) for r in rows]}), 200

    data = request.get_json(silent=True) or {}
    students = d.execute("SELECT id, name FROM students").fetchall()
    try:
        amount = float(data.get("amount", 0))
    except (TypeError, ValueError):
        amount = 0.0
    if not (math.isfinite(amount) and amount > 0):
        return err("Amount must be greater than 0", 400)
    paid_by = data.get("paid_by")
    if resolve_ref(paid_by, students) is None:
        return err(f"Unknown payer: {paid_by!r}", 400)
    split = data.get("split_among")
    if not isinstance(split, list) or not split:
        return err("Choose at least one person to split with", 400)
    for ref in split:
        if resolve_ref(ref, students) is None:
            return err(f"Unknown person in split: {ref!r}", 400)

    title = str(data.get("title") or "Shared Expense").strip()[:100]
    category = str(data.get("category") or "General").strip()[:40]
    timestamp = str(data.get("timestamp") or time.strftime("%Y-%m-%dT%H:%M:%S"))
    cur = d.execute(
        "INSERT INTO expenses (title, amount, paid_by, split_among, category, timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (title, round(amount, 2), json.dumps(paid_by), json.dumps(split), category, timestamp),
    )
    d.commit()
    row = d.execute("SELECT * FROM expenses WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify({"status": "success", "expense": expense_dict(row)}), 201


@app.route("/api/expenses/<int:expense_id>", methods=["DELETE"])
def delete_expense(expense_id):
    """Allows a student to delete an expense they made (in case of mistakes/wrong amounts)."""
    data = request.get_json(silent=True) or {}
    d = db()
    row = d.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if not row:
        return err("Expense not found", 404)
    
    cur = d.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    d.commit()
    return jsonify({"status": "success", "message": "Expense deleted successfully"}), 200


@app.route("/api/admin/delete-expense/<int:expense_id>", methods=["DELETE"])
def admin_delete_expense(expense_id):
    data = request.get_json(silent=True) or {}
    if str(data.get("admin_key", "")) != MASTER_ADMIN_KEY:
        return err("Unauthorized", 403)
    d = db()
    cur = d.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    d.commit()
    if cur.rowcount == 0:
        return err("Not found", 404)
    return jsonify({"status": "success", "message": "Deleted by admin"}), 200


# -------------------------------------------------------------------- cart
def cart_dict(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "price": row["price"],
        "quantity": row["quantity"],
        "added_by": row["added_by"],
        "checked": bool(row["checked"]),
        "created_at": row["created_at"],
    }


def to_bool(value):
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def parse_price(value):
    try:
        price = 0.0 if value is None else float(value)
    except (TypeError, ValueError):
        return None
    return round(price, 2) if math.isfinite(price) and price >= 0 else None


def parse_quantity(value):
    try:
        quantity = 1 if value is None else int(float(value))
    except (TypeError, ValueError):
        return None
    return quantity if 1 <= quantity <= 1000 else None


@app.route("/api/cart", methods=["GET", "POST"])
def cart():
    d = db()
    if request.method == "GET":
        rows = d.execute("SELECT * FROM cart_items ORDER BY id").fetchall()
        return jsonify({"items": [cart_dict(r) for r in rows]}), 200

    data = request.get_json(silent=True) or {}
    name = first_text(data, "name", "item", "title")
    if not name:
        return err("Item name is required", 400)
    price = parse_price(first_value(data, "price", "amount", "unit_price"))
    if price is None:
        return err("Price must be a number, 0 or more", 400)
    quantity = parse_quantity(first_value(data, "quantity", "qty"))
    if quantity is None:
        return err("Quantity must be a whole number from 1 to 1000", 400)
    students = d.execute("SELECT id, name FROM students").fetchall()
    added_by = resolve_ref(first_value(data, "added_by", "addedBy", "student_id"), students)
    cur = d.execute(
        "INSERT INTO cart_items (name, price, quantity, added_by, checked, created_at) "
        "VALUES (?, ?, ?, ?, 0, ?)",
        (name, price, quantity, added_by, time.strftime("%Y-%m-%dT%H:%M:%S")),
    )
    d.commit()
    row = d.execute("SELECT * FROM cart_items WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify({"status": "success", "item": cart_dict(row)}), 201


@app.route("/api/cart/<int:item_id>", methods=["PATCH", "PUT", "DELETE"])
def cart_item(item_id):
    d = db()
    row = d.execute("SELECT * FROM cart_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        return err("Item not found", 404)
    if request.method == "DELETE":
        d.execute("DELETE FROM cart_items WHERE id = ?", (item_id,))
        d.commit()
        return jsonify({"status": "success", "message": "Item removed"}), 200

    data = request.get_json(silent=True) or {}
    name = first_text(data, "name", "item", "title") or row["name"]
    price = row["price"]
    if first_value(data, "price", "amount", "unit_price") is not None:
        price = parse_price(first_value(data, "price", "amount", "unit_price"))
        if price is None:
            return err("Price must be a number, 0 or more", 400)
    quantity = row["quantity"]
    if first_value(data, "quantity", "qty") is not None:
        quantity = parse_quantity(first_value(data, "quantity", "qty"))
        if quantity is None:
            return err("Quantity must be a whole number from 1 to 1000", 400)
    checked = to_bool(data["checked"]) if "checked" in data else bool(row["checked"])
    d.execute(
        "UPDATE cart_items SET name = ?, price = ?, quantity = ?, checked = ? WHERE id = ?",
        (name, price, quantity, int(checked), item_id),
    )
    d.commit()
    row = d.execute("SELECT * FROM cart_items WHERE id = ?", (item_id,)).fetchone()
    return jsonify({"status": "success", "item": cart_dict(row)}), 200


@app.route("/api/cart/checked", methods=["DELETE"])
def cart_clear_checked():
    d = db()
    cur = d.execute("DELETE FROM cart_items WHERE checked = 1")
    d.commit()
    return jsonify({"status": "success", "deleted": cur.rowcount}), 200


# ----------------------------------------------------------------- settle
@app.route("/api/settle", methods=["GET"])
def calculate_settlements():
    d = db()
    students = d.execute("SELECT id, name FROM students ORDER BY id").fetchall()
    balances = {s["id"]: 0.0 for s in students}
    for row in d.execute("SELECT * FROM expenses ORDER BY id"):
        payer = resolve_ref(json.loads(row["paid_by"]), students)
        split = [resolve_ref(r, students) for r in json.loads(row["split_among"])]
        split = list(dict.fromkeys(s for s in split if s is not None))
        if payer is None or not split:
            continue
        share = row["amount"] / len(split)
        balances[payer] += row["amount"]
        for sid in split:
            balances[sid] -= share

    name_counts = Counter(s["name"] for s in students)
    by_name = {}
    for s in students:
        key = s["name"] if name_counts[s["name"]] == 1 else f"{s['name']} (Slot {s['id']})"
        by_name[key] = round(balances[s["id"]], 2)
    by_id = {str(s["id"]): round(balances[s["id"]], 2) for s in students}
    return jsonify({"status": "success", "balances": by_name, "balances_by_id": by_id}), 200


# ------------------------------------------------------------------- admin
@app.route("/api/admin/reset", methods=["POST"])
def admin_reset():
    data = request.get_json(silent=True) or {}
    if str(data.get("admin_key", "")) != MASTER_ADMIN_KEY:
        return err("Unauthorized", 403)
    d = db()
    d.execute("DELETE FROM expenses")
    d.execute("DELETE FROM sqlite_sequence WHERE name = 'expenses'")
    d.execute("DELETE FROM cart_items")
    d.execute("DELETE FROM sqlite_sequence WHERE name = 'cart_items'")
    for i in range(1, NUM_STUDENTS + 1):
        d.execute(
            "UPDATE students SET name = ?, room = ?, pin_hash = NULL WHERE id = ?",
            (f"Student {i}", ROOM, i),
        )
    d.commit()
    _fails.clear()
    return jsonify({"status": "success", "message": "All slots and expenses cleared"}), 200


import os

from flask import send_from_directory


@app.route("/")
@app.route("/index.html")
def serve_index():
    return send_from_directory(".", "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)