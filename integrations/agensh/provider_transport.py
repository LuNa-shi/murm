"""Bind the configured model credential and cutoff in the native egress proxy."""
import json
import os
from pathlib import Path
import runpy
import time
import urllib.error
import urllib.request


class ProviderEndpoint(urllib.request.BaseHandler):
    handler_order = 100

    def __init__(self, route, deadline_file):
        self.endpoint = route['baseUrl'].rstrip('/') + '/responses'
        self.headers = {**route['headers'], 'Authorization': 'Bearer ' + route['apiKey']}
        self.deadline_file = deadline_file

    def http_request(self, request):
        if request.full_url != self.endpoint or request.get_method() != 'POST':
            raise urllib.error.URLError('Request outside the configured Responses endpoint')
        try:
            deadline = float(self.deadline_file.read_text())
        except (OSError, ValueError):
            raise urllib.error.URLError('Research window has not opened') from None
        if time.time() >= deadline:
            raise urllib.error.URLError('Research window ended')
        if json.loads(request.data)['model'] != 'gpt-6.1-sol':
            raise urllib.error.URLError('Model differs from the approved model')
        for name, value in self.headers.items():
            # Python 3.13 merges normal headers after unredirected headers.
            # Remove the worker credential before binding the trusted one.
            request.remove_header(name.capitalize())
            request.add_unredirected_header(name, value)
        return request

    https_request = http_request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


if __name__ == '__main__':
    route = json.loads(Path('/run/agensh-provider/route.json').read_text())
    policy = ProviderEndpoint(route, Path('/run/agensh-clock/deadline'))
    urllib.request.install_opener(urllib.request.build_opener(policy, NoRedirect()))
    os.environ['UPSTREAM_AUTH_TOKEN'] = ''
    runpy.run_path('/opt/strip_metadata_proxy.py', run_name='__main__')
