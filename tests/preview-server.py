"""Local-only editor preview: replaces Firebase with in-memory fixtures, never cloud data."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "connect-src 'none'; img-src 'self' data: blob:; object-src 'none'")
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] in ('/', '/index.html'):
            html = (ROOT / 'index.html').read_text()
            html = re.sub(r'<script src="https://www.gstatic.com/firebasejs/[^\"]+"></script>', '', html)
            html = html.replace('<script src="firebase-config.js"></script>', '<script src="tests/firebase-fixture.js"></script>')
            html = html.replace('your day, in focus', 'isolated editing preview')
            data = html.encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        else:
            super().do_GET()

if __name__ == '__main__':
    print('Isolated preview: http://127.0.0.1:8771', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8771), Handler).serve_forever()
