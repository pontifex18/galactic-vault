#main.py
import os
import socket
import uuid
import sqlite3
import json
import random
from datetime import datetime, timedelta
from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, session, flash, send_from_directory, jsonify, g, abort
from flask_socketio import SocketIO, emit, disconnect
from flask_wtf import CSRFProtect
from flask_wtf.csrf import CSRFError
from werkzeug.security import generate_password_hash, check_password_hash


load_dotenv()

app = Flask(__name__)

# Secure secret key handling: prefer environment-provided key; fall back to a strong ephemeral key but warn.
_secret = os.environ.get('FLASK_SECRET_KEY')
if not _secret:
    _secret = os.urandom(64).hex()
    app.logger.warning('FLASK_SECRET_KEY not set; using ephemeral secret. Set FLASK_SECRET_KEY for production.')
app.secret_key = _secret

# Configurable values (allow overrides via environment)
PORT = int(os.environ.get('PORT', os.environ.get('VAULT_PORT', '8000')))
GAMES_DIR = os.environ.get('GAMES_DIR', 'games')
DB_FILE = os.environ.get('VAULT_DB', 'galactic_vault.db')

# Enable Socket.IO; do not let it manage Flask sessions itself (we manage sessions explicitly)
socketio = SocketIO(app, cors_allowed_origins="*", manage_session=False)

# CSRF protection for POST/PUT/DELETE routes
csrf = CSRFProtect(app)


@app.errorhandler(CSRFError)
def handle_csrf_error(e):
    app.logger.warning('CSRF error: %s', getattr(e, 'description', str(e)))
    flash('Invalid or missing CSRF token. Please retry the action.', 'error')
    return redirect(url_for('login'))

# In-memory tracking for active sessions
online_pings = {}
user_sids = {}

# --- DATABASE HELPERS ---

def get_db_connection():
    """Return a per-request SQLite connection stored on `flask.g`.

    This avoids creating and closing a new connection for every small helper call
    while keeping the connection scoped to the request lifecycle.
    """
    if 'db' not in g:
        conn = sqlite3.connect(DB_FILE, detect_types=sqlite3.PARSE_DECLTYPES)
        conn.row_factory = sqlite3.Row
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db_connection(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    """Initializes the database schema if it doesn't exist."""
    # Use a direct connection here (outside of request context)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    # Users: Approved pilots
    conn.execute('''CREATE TABLE IF NOT EXISTS users 
                    (username TEXT PRIMARY KEY, password TEXT)''')
    # Requests: Pending approvals
    conn.execute('''CREATE TABLE IF NOT EXISTS requests 
                    (username TEXT PRIMARY KEY, password TEXT, message TEXT, submitted_at TEXT)''')
    # Chat: Last 50 messages
    conn.execute('''CREATE TABLE IF NOT EXISTS chat 
                    (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, msg TEXT, time TEXT)''')
    # Favorites: User-game mapping
    conn.execute('''CREATE TABLE IF NOT EXISTS favorites 
                    (user_id TEXT, game_name TEXT, PRIMARY KEY (user_id, game_name))''')
    # History: Recent plays
    conn.execute('''CREATE TABLE IF NOT EXISTS history 
                    (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, game_name TEXT, last_played TIMESTAMP)''')
    # Issues: User reports
    conn.execute('''CREATE TABLE IF NOT EXISTS issues 
                    (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, game_name TEXT, report TEXT, timestamp TEXT)''')
    # Known Issues: Admin notes shown to users
    conn.execute('''CREATE TABLE IF NOT EXISTS known_issues 
                    (id INTEGER PRIMARY KEY AUTOINCREMENT, game_name TEXT, note TEXT)''')
    # Per-user settings (key/value)
    conn.execute('''CREATE TABLE IF NOT EXISTS user_settings
                    (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key))''')
    # Track active sessions so we can attempt to enforce single-session logins
    conn.execute('''CREATE TABLE IF NOT EXISTS active_sessions
                    (user_id TEXT PRIMARY KEY, sid TEXT, last_seen TIMESTAMP)''')
    conn.commit()
    conn.close()


def _get_active_session_sid(username):
    try:
        c = sqlite3.connect(DB_FILE)
        c.row_factory = sqlite3.Row
        row = c.execute('SELECT sid FROM active_sessions WHERE user_id = ?', (username,)).fetchone()
        return row['sid'] if row else None
    finally:
        c.close()


def _set_active_session(username, sid):
    c = sqlite3.connect(DB_FILE)
    try:
        c.execute('INSERT OR REPLACE INTO active_sessions (user_id, sid, last_seen) VALUES (?, ?, ?)',
                  (username, sid, datetime.now()))
        c.commit()
    finally:
        c.close()


def _clear_active_session_by_sid(sid):
    c = sqlite3.connect(DB_FILE)
    try:
        c.execute('DELETE FROM active_sessions WHERE sid = ?', (sid,))
        c.commit()
    finally:
        c.close()


def get_user_setting(user_id, key, default=None):
    conn = get_db_connection()
    row = conn.execute('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', (user_id, key)).fetchone()
    return row['value'] if row else default


def set_user_setting(user_id, key, value):
    conn = get_db_connection()
    conn.execute('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)',
                 (user_id, key, value))
    conn.commit()


@app.context_processor
def inject_user_settings():
    show_comm_popup = True
    if session.get('user_id'):
        val = get_user_setting(session['user_id'], 'show_comm_popup', '1')
        show_comm_popup = (val == '1' or val is True)
    return {'show_comm_popup': show_comm_popup}

# --- AUTHENTICATION HELPERS ---

def check_credentials(username, password):
    """Validates hashed credentials against the SQLite database."""
    conn = get_db_connection()
    user = conn.execute('SELECT password FROM users WHERE username = ?', (username,)).fetchone()
    if user and check_password_hash(user['password'], password):
        return True
    return False

# --- CHAT HELPERS ---

def load_chat():
    conn = get_db_connection()
    rows = conn.execute('SELECT user, msg, time FROM chat ORDER BY id ASC').fetchall()
    return [dict(row) for row in rows]

def save_message(msg_data):
    conn = get_db_connection()
    conn.execute('INSERT INTO chat (user, msg, time) VALUES (?, ?, ?)',
                 (msg_data['user'], msg_data['msg'], msg_data['time']))
    # Keep only last 50 messages
    conn.execute('DELETE FROM chat WHERE id NOT IN (SELECT id FROM chat ORDER BY id DESC LIMIT 50)')
    conn.commit()

# --- GAME DATA HELPERS ---

def get_game_config(game_name):
    config_path = os.path.join(GAMES_DIR, game_name, 'config.json')
    defaults = {"external": False, "description": "No mission briefing available."}
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                return {**defaults, **json.load(f)}
        except (IOError, json.JSONDecodeError) as e:
            app.logger.exception('Error reading config for %s: %s', game_name, e)
            return defaults
    return defaults

def record_play(user_id, game_name):
    """Logs game play to SQLite history."""
    conn = get_db_connection()
    # Remove old entry for this game if it exists to refresh 'last_played'
    conn.execute('DELETE FROM history WHERE user_id = ? AND game_name = ?', (user_id, game_name))
    conn.execute('INSERT INTO history (user_id, game_name, last_played) VALUES (?, ?, ?)',
                 (user_id, game_name, datetime.now()))
    # Limit history to 12 items
    conn.execute('''DELETE FROM history WHERE user_id = ? AND id NOT IN 
                    (SELECT id FROM history WHERE user_id = ? ORDER BY last_played DESC LIMIT 12)''', 
                 (user_id, user_id))
    conn.commit()

# --- MIDDLEWARE ---

@app.before_request
def check_session():
    # Session validity is now maintained without a server-side timeout.
    # Keep this hook lightweight: just ensure the session user exists.
    if 'user_id' not in session:
        return

# --- ROUTES ---

@app.route('/')
def index():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    
    games_list = []
    if os.path.exists(GAMES_DIR):
        try:
            dirs = [d for d in os.listdir(GAMES_DIR) if os.path.isdir(os.path.join(GAMES_DIR, d))]
        except OSError:
            dirs = []
        for game in dirs:
            safe_name = os.path.basename(game)
            if not safe_name or safe_name != game or safe_name.startswith('.'):
                continue
            has_thumb = os.path.exists(os.path.join(GAMES_DIR, game, 'thumbnail.png'))
            games_list.append({'name': game, 'has_thumb': has_thumb})

    return render_template('template.html', view="menu", title="Vault", header="Game Library", games=games_list)

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()
        
        if check_credentials(username, password):
            # Enforce single-session: if another session exists, attempt to notify and disconnect it
            existing_sid = _get_active_session_sid(username)
            if existing_sid:
                try:
                    socketio.emit('force_logout', {'reason': 'New login from another location.'}, to=existing_sid)
                    # Attempt to close the previous socket connection
                    try:
                        socketio.disconnect(existing_sid)
                    except Exception:
                        app.logger.debug('socketio.disconnect failed for sid %s', existing_sid)
                except Exception:
                    app.logger.exception('Error while forcing logout for existing session')
                finally:
                    # Clean up any in-memory tracking for the old session
                    online_pings.pop(existing_sid, None)
                    if user_sids.get(username) == existing_sid:
                        user_sids.pop(username, None)
                    _clear_active_session_by_sid(existing_sid)

            # Create the Flask session. Socket.IO connect will register the active sid.
            session['user_id'] = username
            # Record an active session placeholder without SID; the real SID will be set on socket connect
            _set_active_session(username, None)
            return redirect(url_for('index'))
        
        flash("ACCESS DENIED: INVALID CREDENTIALS")
        return redirect(url_for('login'))
    
    return render_template('login.html')

@app.route('/signup')
def signup():
    return render_template('requestaccess.html')

@app.route('/submit-request', methods=['POST'])
def submit_request():
    username = request.form.get('username', '').strip()
    password = request.form.get('password', '').strip()
    message = request.form.get('message', '').strip()

    if not username or not password:
        flash("Username and password are required.")
        return redirect(url_for('signup'))

    conn = get_db_connection()
    try:
        conn.execute('INSERT INTO requests (username, password, message, submitted_at) VALUES (?, ?, ?, ?)',
                     (username, password, message, datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
        conn.commit()
        flash("Your request has been sent for approval.", "success")
    except sqlite3.IntegrityError:
        flash("A request for this username already exists.")
    finally:
        pass

    return redirect(url_for('login'))

@app.route('/logout')
def logout():
    # Clearing the session is enough; Socket.IO disconnects will update presence.
    session.clear()
    return redirect(url_for('login'))

@app.route('/play/<game_name>')
def play(game_name):
    if 'user_id' not in session:
        return redirect(url_for('login'))
    
    record_play(session['user_id'], game_name)
    config = get_game_config(game_name)
    
    # Fetch known issues for this specific game
    conn = get_db_connection()
    known_issues = conn.execute('SELECT note FROM known_issues WHERE game_name = ?', (game_name,)).fetchall()
    
    return render_template('template.html', view="player", title=game_name.upper(), 
                           header="System Online", game_name=game_name,
                           external=config['external'], description=config['description'],
                           known_issues=known_issues)

@app.route('/api/games')
def api_games():
    if 'user_id' not in session: return jsonify({"error": "Unauthorized"}), 401
    search_query = request.args.get('q', '').lower()
    games_list = []
    try:
        dirs = [d for d in os.listdir(GAMES_DIR) if os.path.isdir(os.path.join(GAMES_DIR, d))]
    except OSError:
        return jsonify([])

    for game in dirs:
        # Basic sanitation: use the base name and skip suspicious entries
        safe_name = os.path.basename(game)
        if not safe_name or safe_name != game or safe_name.startswith('.'):
            continue
        if search_query and search_query not in game.lower():
            continue
        has_thumb = os.path.exists(os.path.join(GAMES_DIR, game, 'thumbnail.png'))
        games_list.append({'name': game, 'has_thumb': has_thumb})
    if not search_query: random.shuffle(games_list)
    return jsonify(games_list)

@app.route('/api/recent')
def api_recent():
    if 'user_id' not in session: return jsonify([])
    conn = get_db_connection()
    rows = conn.execute('SELECT game_name FROM history WHERE user_id = ? ORDER BY last_played DESC', 
                        (session['user_id'],)).fetchall()
    
    recent_games = []
    for row in rows:
        game = row['game_name']
        if os.path.exists(os.path.join(GAMES_DIR, game)):
            recent_games.append({
                'name': game, 
                'has_thumb': os.path.exists(os.path.join(GAMES_DIR, game, 'thumbnail.png'))
            })
    return jsonify(recent_games)

@app.route('/api/favorites')
def api_favorites():
    if 'user_id' not in session: return jsonify([])
    conn = get_db_connection()
    rows = conn.execute('SELECT game_name FROM favorites WHERE user_id = ?', (session['user_id'],)).fetchall()
    
    fav_games = []
    for row in rows:
        game = row['game_name']
        if os.path.exists(os.path.join(GAMES_DIR, game)):
            fav_games.append({
                'name': game, 
                'has_thumb': os.path.exists(os.path.join(GAMES_DIR, game, 'thumbnail.png'))
            })
    return jsonify(fav_games)

@app.route('/api/toggle-favorite', methods=['POST'])
def toggle_favorite():
    if 'user_id' not in session: return jsonify({"error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    game_name = data.get('game')
    if not game_name: return jsonify({"error": "No game specified"}), 400
        
    user_id = session['user_id']
    conn = get_db_connection()
    
    # Check if exists
    exists = conn.execute('SELECT 1 FROM favorites WHERE user_id = ? AND game_name = ?', 
                          (user_id, game_name)).fetchone()
    
    if exists:
        conn.execute('DELETE FROM favorites WHERE user_id = ? AND game_name = ?', (user_id, game_name))
        status = "removed"
    else:
        conn.execute('INSERT INTO favorites (user_id, game_name) VALUES (?, ?)', (user_id, game_name))
        status = "added"
        
    conn.commit()
    return jsonify({"status": status})

# --- ADMIN ROUTES ---

@app.route('/admin/dashboard')
def admin_dashboard():
    if session.get('user_id') != 'admin':
        flash("UNAUTHORIZED ACCESS DETECTED", "error")
        return redirect(url_for('index'))
    
    conn = get_db_connection()
    pending_requests = conn.execute('SELECT * FROM requests').fetchall()
    
    # Fetch user reports and active known issues
    user_reports = conn.execute('SELECT * FROM issues ORDER BY timestamp DESC').fetchall()
    current_known = conn.execute('SELECT * FROM known_issues').fetchall()
    
    requests_dict = {row['username']: dict(row) for row in pending_requests}

    # Build current online pilots list from socket pings
    current_online = list(set(data['user'] for data in online_pings.values()))

    return render_template('template.html', view="admin", title="Admin Terminal", 
                           header="System Control", pending_requests=requests_dict,
                           active_pilots=current_online, user_reports=user_reports, 
                           current_known=current_known)

@app.route('/admin/action/<action>/<username>', methods=['POST'])
def admin_action(action, username):
    if session.get('user_id') != 'admin':
        return jsonify({"error": "Unauthorized"}), 403

    conn = get_db_connection()
    req = conn.execute('SELECT * FROM requests WHERE username = ?', (username,)).fetchone()

    if req:
        if action == 'approve':
            hashed_pw = generate_password_hash(req['password'])
            conn.execute('INSERT INTO users (username, password) VALUES (?, ?)', (req['username'], hashed_pw))
            conn.execute('DELETE FROM requests WHERE username = ?', (username,))
            flash(f"User {username} approved.", "success")
        elif action == 'deny':
            conn.execute('DELETE FROM requests WHERE username = ?', (username,))
            flash(f"Request from {username} deleted.", "error")
        conn.commit()
    
    return redirect(url_for('admin_dashboard'))

# --- SOCKETS ---

def broadcast_admin_update():
    # Extract unique usernames from the online_pings dictionary
    # (Since one user might have multiple tabs open/multiple SIDs)
    current_online = list(set(data['user'] for data in online_pings.values()))
    
    # Broadcast this list to EVERYONE connected
    socketio.emit('admin_user_update', {'users': current_online})

@socketio.on('connect')
def handle_connect():
    user_id = session.get('user_id')
    sid = getattr(request, 'sid', None)

    if user_id and sid:
        # Prefer in-memory mapping, fall back to DB persisted SID
        existing_sid = user_sids.get(user_id) or _get_active_session_sid(user_id)

        # If another SID exists, attempt to notify and disconnect it so the new session becomes active
        if existing_sid and existing_sid != sid:
            try:
                socketio.emit('force_logout', {'reason': 'Your session was terminated due to a new login.'}, to=existing_sid)
                try:
                    socketio.disconnect(existing_sid)
                except Exception:
                    app.logger.debug('Failed to socketio.disconnect sid %s', existing_sid)
            except Exception:
                app.logger.exception('Error while forcing logout for sid %s', existing_sid)

            # Clean up previous mappings
            online_pings.pop(existing_sid, None)
            if user_sids.get(user_id) == existing_sid:
                user_sids.pop(user_id, None)
            _clear_active_session_by_sid(existing_sid)

        # Register this socket as the active session for the user
        user_sids[user_id] = sid
        online_pings[sid] = {'user': user_id, 'seen': datetime.now()}
        _set_active_session(user_id, sid)

    # Load history and update UI
    emit('chat_history', load_chat())
    broadcast_admin_update()

@socketio.on('disconnect')
def handle_disconnect():
    sid = getattr(request, 'sid', None)
    if sid in online_pings:
        user = online_pings[sid]['user']
        del online_pings[sid]
        # If this sid was the registered user's active sid, remove it
        if user_sids.get(user) == sid:
            user_sids.pop(user, None)
        # Clear persisted active session for this SID
        _clear_active_session_by_sid(sid)
    broadcast_admin_update()

@socketio.on('message')
def handle_message(data):
    if not data or not data.get('msg'):
        return
    user_id = session.get('user_id', 'Unknown Pilot')
    # Enforce a reasonable maximum length to reduce abuse and stored XSS surface
    raw_msg = str(data.get('msg', ''))
    safe_msg = raw_msg[:512]
    msg_data = {'user': user_id, 'msg': safe_msg, 'time': datetime.now().strftime("%H:%M")}
    save_message(msg_data)
    emit('message', msg_data, broadcast=True)

@app.route('/games/<path:filename>')
def serve_game(filename):
    # Basic path validation to avoid directory traversal
    if '..' in filename or filename.startswith('/') or '\x00' in filename:
        abort(400)
    return send_from_directory(GAMES_DIR, filename)

@app.route('/settings')
def settings():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('template.html', view="settings", title="Settings", header="System Configuration")


@app.route('/update-settings', methods=['POST'])
def update_settings():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    show_comm = request.form.get('show_comm_popup')
    set_user_setting(session['user_id'], 'show_comm_popup', '1' if show_comm == 'on' else '0')
    flash("Settings updated.", "success")
    return redirect(url_for('settings'))

@app.route('/update-credentials', methods=['POST'])
def update_credentials():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    
    user_id = session['user_id']
    action = request.form.get('action')
    current_password = request.form.get('current_password')
    
    # Verify current password before allowing changes
    if not check_credentials(user_id, current_password):
        flash("ACCESS DENIED: INCORRECT CURRENT PASSWORD", "error")
        return redirect(url_for('settings'))

    conn = get_db_connection()
    try:
        if action == 'username':
            new_username = request.form.get('new_username', '').strip()
            if not new_username:
                flash("ERROR: INVALID USERNAME", "error")
            else:
                # Update username across all linked tables to maintain history
                conn.execute('UPDATE users SET username = ? WHERE username = ?', (new_username, user_id))
                conn.execute('UPDATE chat SET user = ? WHERE user = ?', (new_username, user_id))
                conn.execute('UPDATE favorites SET user_id = ? WHERE user_id = ?', (new_username, user_id))
                conn.execute('UPDATE history SET user_id = ? WHERE user_id = ?', (new_username, user_id))
                
                # Update session (presence is handled via Socket.IO connections)
                session['user_id'] = new_username
                flash("USERNAME UPDATED SUCCESSFULLY")

        elif action == 'password':
            new_password = request.form.get('new_password', '').strip()
            hashed_pw = generate_password_hash(new_password)
            conn.execute('UPDATE users SET password = ? WHERE username = ?', (hashed_pw, user_id))
            flash("PASSWORD UPDATED SUCCESSFULLY")
        
        conn.commit()
    except sqlite3.IntegrityError:
        flash("ERROR: USERNAME ALREADY IN USE", "error")
    finally:
        pass

    return redirect(url_for('settings'))

@app.route('/api/report-issue', methods=['POST'])
def report_issue():
    if 'user_id' not in session: return jsonify({"error": "Unauthorized"}), 401
    data = request.get_json(silent=True)
    if not data or not data.get('game') or not data.get('report'):
        return jsonify({"error": "Missing required fields"}), 400
    
    conn = get_db_connection()
    try:
        conn.execute('INSERT INTO issues (user_id, game_name, report, timestamp) VALUES (?, ?, ?, ?)',
                     (session['user_id'], data['game'], data['report'], datetime.now().strftime("%Y-%m-%d %H:%M")))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        pass

@app.route('/admin/promote-report', methods=['POST'])
def promote_report():
    if session.get('user_id') != 'admin': return redirect(url_for('index'))
    
    report_id = request.form.get('report_id')
    game_name = request.form.get('game_name')
    note = request.form.get('note')
    
    if not report_id or not game_name or not note:
        flash("ERROR: Missing required fields", "error")
        return redirect(url_for('admin_dashboard'))

    conn = get_db_connection()
    try:
        # 1. Add to the public alerts table
        conn.execute('INSERT INTO known_issues (game_name, note) VALUES (?, ?)', (game_name, note))
        # 2. Remove from the private reports table
        conn.execute('DELETE FROM issues WHERE id = ?', (report_id,))
        conn.commit()
        flash(f"Report for {game_name} promoted to Known Issue.", "success")
    except Exception as e:
        flash(f"ERROR: {str(e)}", "error")
    finally:
        pass
    
    return redirect(url_for('admin_dashboard'))

@app.route('/admin/known-issue/<action>', methods=['POST'])
def admin_known_issue(action):
    if session.get('user_id') != 'admin': return redirect(url_for('index'))
    
    conn = get_db_connection()
    try:
        if action == 'add':
            game_name = request.form.get('game_name', '').strip()
            note = request.form.get('note', '').strip()
            if not game_name or not note:
                flash("ERROR: Game name and note are required", "error")
            else:
                conn.execute('INSERT INTO known_issues (game_name, note) VALUES (?, ?)', (game_name, note))
                conn.commit()
                flash("Manual alert posted.", "success")
        elif action == 'remove':
            issue_id = request.form.get('issue_id')
            if not issue_id:
                flash("ERROR: Issue ID is required", "error")
            else:
                conn.execute('DELETE FROM known_issues WHERE id = ?', (issue_id,))
                conn.commit()
                flash("System alert resolved.", "success")
    except Exception as e:
        flash(f"ERROR: {str(e)}", "error")
    finally:
        pass
    return redirect(url_for('admin_dashboard'))

@app.route('/chat')
def chat():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    
    conn = get_db_connection()
    # Fetch all registered users
    all_users = conn.execute('SELECT username FROM users').fetchall()
    
    pilots = []
    # Build a set of currently online usernames from socket pings
    current_online = set(data['user'] for data in online_pings.values())
    for u in all_users:
        uname = u['username']
        is_online = uname in current_online
        pilots.append({
            'username': uname,
            'online': is_online
        })
    
    # Sort: Online (True/1) comes before Offline (False/0)
    pilots.sort(key=lambda x: x['online'], reverse=True)
    
    return render_template('template.html', view="chat", title="Chat", 
                           header="Communications", pilots=pilots)

if __name__ == '__main__':
    init_db() # Create the DB and tables on launch
    
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1)) # Hack that gets IP adress
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()

    print(f"\n🚀 SERVER STARTING\n🏠 Local Access: http://127.0.0.1:{PORT}\n🌐 LAN Access:   http://{IP}:{PORT}\n")
    socketio.run(app, host='0.0.0.0', port=PORT, debug=True)
    