# public.py
import os
from main import app, socketio, init_db
from werkzeug.middleware.proxy_fix import ProxyFix

# 1. Apply ProxyFix
# This allows Flask to see the real user IP and use the correct 
# protocol (http vs https) when it's sitting behind Nginx.
app.wsgi_app = ProxyFix(
    app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1, x_prefix=1
)

def run_public_server():
    # 2. Initialize the database (from main.py logic)
    print("[*] Initializing Database...")
    init_db()

    # 3. Launch the server
    # We use 127.0.0.1 so only Nginx can talk to it locally.
    # We use a different port (8080) so it doesn't clash with your default 8000.
    internal_port = 8080
    print(f"[*] Public Shield Active. Forwarding Nginx -> Port {internal_port}")
    
    socketio.run(
        app, 
        host='127.0.0.1', 
        port=internal_port, 
        debug=False,      # Keep debug OFF for public exposure
        use_reloader=False 
    )

if __name__ == '__main__':
    run_public_server()