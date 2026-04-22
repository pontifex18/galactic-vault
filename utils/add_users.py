import sqlite3
import os

# Configuration: Points to the same DB file as your main.py
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "galaxy_vault.db")

def get_db_connection():
    """Establishes a connection to the SQLite database."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def main():
    if not os.path.exists(DB_FILE):
        print(f"Error: Database file not found at {DB_FILE}")
        return

    conn = get_db_connection()
    cursor = conn.cursor()

    # Fetch all pending requests from SQLite
    requests = cursor.execute('SELECT * FROM requests').fetchall()

    if not requests:
        print("No pending access requests found.")
        conn.close()
        return

    print(f"--- Found {len(requests)} pending requests ---\n")
    
    for req in requests:
        username = req['username']
        print(f"USERNAME: {username}")
        print(f"PASSWORD: {req['password']}") 
        print(f"TIME: {req['submitted_at']}")
        print(f"MESSAGE: {req['message']}")
        print("-" * 30)
        
        choice = input(f"Approve '{username}'? (Y/N/Skip): ").lower().strip()
        
        if choice == 'y':
            # SQLite Transaction: Add to users, remove from requests
            try:
                cursor.execute('INSERT OR REPLACE INTO users (username, password) VALUES (?, ?)', 
                               (req['username'], req['password']))
                cursor.execute('DELETE FROM requests WHERE username = ?', (username,))
                conn.commit()
                print(f"✅ Approved {username}\n")
            except Exception as e:
                print(f"❌ Error approving {username}: {e}")
                conn.rollback()

        elif choice == 'n':
            # Just delete the request from SQLite
            cursor.execute('DELETE FROM requests WHERE username = ?', (username,))
            conn.commit()
            print(f"❌ Denied {username}\n")
        else:
            print("⏩ Skipped (Request remains pending)\n")

    conn.close()
    print("Vault updated. All changes saved to database.")

if __name__ == "__main__":
    main()