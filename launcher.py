import os
import sys
import threading
import webbrowser
from pathlib import Path
import http.client
from time import sleep
import subprocess

def check_ffmpeg():
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True)
        return True
    except FileNotFoundError:
        print("FFmpeg not found! Installing...")
        return False

def setup_folders(base_dir):
    """Create required folders if they don't exist"""
    (base_dir / "clips").mkdir(exist_ok=True)
    (base_dir / "tmp").mkdir(exist_ok=True)

def wait_for_server(port):
    """Wait for Flask server to start"""
    for _ in range(30):  # 30 second timeout
        try:
            conn = http.client.HTTPConnection(f"127.0.0.1:{port}")
            conn.request("GET", "/")
            resp = conn.getresponse()
            if resp.status < 400:
                return True
        except:
            sleep(1)
    return False

def open_browser(port):
    """Open browser after server starts"""
    print("Waiting for server to start...")
    if wait_for_server(port):
        print(f"Opening http://localhost:{port}")
        webbrowser.open(f'http://localhost:{port}')
    else:
        print("Server failed to start!")

def main():
    if getattr(sys, 'frozen', False):
        base_dir = Path(sys._MEIPASS)
        os.chdir(base_dir)
    else:
        base_dir = Path(__file__).resolve().parent

    # Check FFmpeg
    if not check_ffmpeg():
        print("Please install FFmpeg to continue")
        input("Press Enter to exit...")
        sys.exit(1)

    # Set up folders
    setup_folders(base_dir)
    
    # Import Flask app
    sys.path.insert(0, str(base_dir / "backend"))
    from app import app
    
    # Start browser opener in a separate thread
    browser_thread = threading.Thread(
        target=lambda: open_browser(5000),
        daemon=True
    )
    browser_thread.start()
    
    # Run Flask app
    print("Starting server...")
    app.run(host="127.0.0.1", port=5000, debug=False)

if __name__ == '__main__':
    main()