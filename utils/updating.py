import os
import socket
import toml
from flask import Flask, render_template_string

app = Flask(__name__)

# Load fallback configurations from your config.toml if it exists
try:
    with open('config.toml', 'r') as f:
        config_data = toml.load(f)
except Exception:
    config_data = {}

PORT = int(config_data.get('port', os.environ.get('PORT', 8000)))
HOST = config_data.get('host', '0.0.0.0')

# Minimalist, sci-fi themed maintenance template matching your "Vault" aesthetic
MAINTENANCE_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vault - System Maintenance</title>
    <style>
        body {
            background-color: #0d1117;
            color: #58a6ff;
            font-family: 'Courier New', Courier, monospace;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
        }
        .container {
            border: 2px dashed #1f6feb;
            padding: 40px;
            background-color: #161b22;
            box-shadow: 0 0 20px rgba(31, 111, 235, 0.2);
            border-radius: 8px;
            max-width: 500px;
        }
        h1 {
            color: #ff7b72;
            margin-top: 0;
            font-size: 2rem;
            letter-spacing: 2px;
        }
        p {
            color: #c9d1d9;
            font-size: 1.1rem;
            line-height: 1.6;
        }
        .timer {
            font-weight: bold;
            color: #f0883e;
        }
        .status-pulse {
            display: inline-block;
            width: 12px;
            height: 12px;
            background-color: #ff7b72;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0% { transform: scale(0.9); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.4; }
            100% { transform: scale(0.9); opacity: 1; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1><span class="status-pulse"></span>VAULT OFFLINE</h1>
        <hr style="border-color: #21262d; margin-bottom: 20px;">
        <p>The Galactic Vault is currently undergoing scheduled engineering maintenance.</p>
        <p>System stabilization is in progress. Estimated completion time:</p>
        <p class="timer">⏳ 5 - 10 MINUTES</p>
    </div>
</body>
</html>
"""

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def catch_all(path):
    """Catches all traffic (including older game or api routes) and displays the maintenance page."""
    return render_template_string(MAINTENANCE_TEMPLATE), 503

if __name__ == '__main__':
    # Replicate your LAN IP discovery snippet
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()

    print(f"\n⚙️  MAINTENANCE SERVER ACTIVE")
    print(f"🏠 Local Access: http://127.0.0.1:{PORT}")
    print(f"🌐 LAN Access:   http://{IP}:{PORT}\n")
    
    app.run(host=HOST, port=PORT, debug=False)