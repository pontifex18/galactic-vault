import sqlite3
from werkzeug.security import generate_password_hash

DB_FILE = "galactic_vault.db"

def migrate_passwords():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    print("🚀 Starting password migration...")

    # 1. Migrate the 'users' table
    users = cursor.execute('SELECT username, password FROM users').fetchall()
    for user in users:
        # Check if password is already hashed (Werkzeug hashes usually start with 'scrypt' or 'pbkdf2')
        if not user['password'].startswith(('scrypt:', 'pbkdf2:')):
            hashed_pw = generate_password_hash(user['password'])
            cursor.execute('UPDATE users SET password = ? WHERE username = ?', (hashed_pw, user['username']))
            print(f"✅ Hashed password for user: {user['username']}")

    # 2. Migrate the 'requests' table
    requests = cursor.execute('SELECT username, password FROM requests').fetchall()
    for req in requests:
        if not req['password'].startswith(('scrypt:', 'pbkdf2:')):
            hashed_pw = generate_password_hash(req['password'])
            cursor.execute('UPDATE requests SET password = ? WHERE username = ?', (hashed_pw, req['username']))
            print(f"✅ Hashed password for pending request: {req['username']}")

    conn.commit()
    conn.close()
    print("\n✨ Migration complete! All passwords are now secure.")

if __name__ == "__main__":
    migrate_passwords()