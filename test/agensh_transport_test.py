"""Run in the egress Python version. Exercise headers on the wire with no research model."""
import http.server
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'agensh'))
from provider_transport import NoRedirect, ProviderEndpoint


class TransportTest(unittest.TestCase):
    def test_replaces_worker_secret_and_enforces_deadline(self):
        received = []

        class Target(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(self.headers.get_all('Authorization'))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Target) as httpd, tempfile.TemporaryDirectory() as tmp:
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            route = {'baseUrl': f'http://127.0.0.1:{httpd.server_port}/v1', 'apiKey': 'fixture-upstream', 'headers': {}}
            deadline = Path(tmp) / 'deadline'
            client = urllib.request.build_opener(ProviderEndpoint(route, deadline), NoRedirect())
            request = urllib.request.Request(route['baseUrl'] + '/responses', json.dumps({'model': 'gpt-6.1-sol'}).encode(),
                                             headers={'Authorization': 'Bearer fixture-worker'})
            try:
                deadline.write_text(str(time.time() + 60))
                with client.open(request, timeout=3) as response:
                    self.assertEqual(response.status, 200)
                deadline.write_text('0')
                with self.assertRaises(urllib.error.URLError):
                    client.open(request, timeout=3)
                self.assertEqual(received, [['Bearer fixture-upstream']])
            finally:
                httpd.shutdown()


if __name__ == '__main__':
    unittest.main()
