import sqlite3
import os

def port_database(old_db_path='OLD.db', new_db_path='new.db'):
    # Remove new.db if it already exists to start fresh
    if os.path.exists(new_db_path):
        os.remove(new_db_path)

    # Connect to both databases
    old_conn = sqlite3.connect(old_db_path)
    new_conn = sqlite3.connect(new_db_path)
    
    old_cursor = old_conn.cursor()
    new_cursor = new_conn.cursor()

    print(f"Creating schema in '{new_db_path}'...")

    # 1. Initialize the new galactic_vault schema in new.db
    schema_statements = [
        """CREATE TABLE users (
            username TEXT PRIMARY KEY, 
            password TEXT, 
            role TEXT DEFAULT 'Crew'
        );""",
        """CREATE TABLE requests (
            username TEXT PRIMARY KEY, 
            password TEXT, 
            message TEXT, 
            submitted_at TEXT
        );""",
        """CREATE TABLE chat (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            user TEXT, 
            msg TEXT, 
            time TEXT, 
            channel TEXT DEFAULT 'General'
        );""",
        """CREATE TABLE favorites (
            user_id TEXT, 
            game_name TEXT, 
            PRIMARY KEY (user_id, game_name)
        );""",
        """CREATE TABLE history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            user_id TEXT, 
            game_name TEXT, 
            last_played TIMESTAMP
        );""",
        """CREATE TABLE issues (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            user_id TEXT, 
            game_name TEXT, 
            report TEXT, 
            timestamp TEXT
        );""",
        """CREATE TABLE known_issues (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            game_name TEXT, 
            note TEXT
        );""",
        """CREATE TABLE profiles (
            username TEXT PRIMARY KEY, 
            description TEXT, 
            avatar_filename TEXT
        );""",
        """CREATE TABLE direct_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            from_user TEXT, 
            to_user TEXT, 
            msg TEXT, 
            time TEXT, 
            delivered INTEGER DEFAULT 0
        );""",
        """CREATE TABLE user_settings (
            user_id TEXT, 
            key TEXT, 
            value TEXT, 
            PRIMARY KEY (user_id, key)
        );""",
        """CREATE TABLE active_sessions (
            user_id TEXT PRIMARY KEY, 
            sid TEXT, 
            last_seen TIMESTAMP, 
            activity TEXT DEFAULT 'Browsing'
        );"""
    ]

    for statement in schema_statements:
        new_cursor.execute(statement)
    new_conn.commit()

    # 2. Port the data table by table
    # Mapping table names to their respective column structures in OLD.db
    tables_to_port = {
        'users': ['username', 'password'],
        'requests': ['username', 'password', 'message', 'submitted_at'],
        'chat': ['id', 'user', 'msg', 'time'],
        'favorites': ['user_id', 'game_name'],
        'history': ['id', 'user_id', 'game_name', 'last_played'],
        'issues': ['id', 'user_id', 'game_name', 'report', 'timestamp'],
        'known_issues': ['id', 'game_name', 'note'],
        'profiles': ['username', 'description', 'avatar_filename'],
        'direct_messages': ['id', 'from_user', 'to_user', 'msg', 'time', 'delivered'],
        'user_settings': ['user_id', 'key', 'value'],
        'active_sessions': ['user_id', 'sid', 'last_seen']
    }

    print("Migrating records...")
    for table_name, columns in tables_to_port.items():
        # Build dynamic queries targeting exactly the columns that exist in OLD.db
        column_list = ", ".join(columns)
        placeholders = ", ".join(["?"] * len(columns))
        
        # Read from old.db
        old_cursor.execute(f"SELECT {column_list} FROM {table_name}")
        rows = old_cursor.fetchall()
        
        # Write to new.db (the remaining omitted schema columns will inherit defaults)
        if rows:
            new_cursor.executemany(
                f"INSERT INTO {table_name} ({column_list}) VALUES ({placeholders})", 
                rows
            )
            print(f" -> Ported {len(rows)} records into table '{table_name}'")
        else:
            print(f" -> Table '{table_name}' was empty.")

    # Commit changes and clean up
    new_conn.commit()
    old_conn.close()
    new_conn.close()
    print(f"\nPort complete! Successfully generated '{new_db_path}'.")

if __name__ == '__main__':
    port_database()