"""Attach the operator's provider headers inside the native egress proxy only."""
import json
import os
from pathlib import Path
import runpy
import time
import urllib.error
import urllib.request

route = json.loads(Path('/run/agensh-provider/route.json').read_text())
endpoint = route['baseUrl'].rstrip('/') + '/responses'


class ProviderEndpoint(urllib.request.BaseHandler):
    handler_order = 100

    def http_request(self, request):
        if request.full_url != endpoint or request.get_method() != 'POST':
            raise urllib.error.URLError('Request outside the configured Responses endpoint')
        try:
            deadline = float(Path('/run/agensh-clock/deadline').read_text())
        except (OSError, ValueError):
            raise urllib.error.URLError('Research window has not opened') from None
        if time.time() >= deadline:
            raise urllib.error.URLError('Research window ended')
        if json.loads(request.data)['model'] != 'gpt-6.1-sol':
            raise urllib.error.URLError('Model differs from the approved model')
        for name, value in route['headers'].items():
            request.add_unredirected_header(name, value)
        request.add_unredirected_header('Authorization', 'Bearer ' + route['apiKey'])
        return request

    https_request = http_request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


urllib.request.install_opener(urllib.request.build_opener(ProviderEndpoint(), NoRedirect()))
os.environ['UPSTREAM_AUTH_TOKEN'] = ''
runpy.run_path('/opt/strip_metadata_proxy.py', run_name='__main__')
