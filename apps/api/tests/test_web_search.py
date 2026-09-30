import json
import unittest

import httpx
from pydantic import ValidationError

from app.services.tool_execution import execute_tool_call
from app.tools import ToolRegistry, WebSearchInput, WebSearchTool, create_default_tool_registry


class WebSearchTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, handler, **arguments):
        registry = ToolRegistry([WebSearchTool(transport=httpx.MockTransport(handler))])
        return await execute_tool_call(
            registry=registry, name="web_search", arguments_json=json.dumps(arguments),
        )

    async def test_live_contract_encoding_and_result_bounds(self):
        def handler(request):
            self.assertEqual(request.url.params["q"], "C++ & Python")
            self.assertEqual(request.url.params["format"], "rss")
            return httpx.Response(200, text='''<rss><channel>
                <item><title>Python &amp; docs</title><link>https://docs.python.org/</link>
                <description>&lt;b&gt;Official&lt;/b&gt; docs</description></item>
                <item><link>javascript:alert(1)</link></item>
                <item><link>https://docs.python.org/</link></item>
                <item><title>Second</title><link>https://python.org/</link></item>
                </channel></rss>''')
        result = await self.call(handler, query=" C++ & Python ", max_results=1)
        self.assertFalse(result.is_error)
        payload = json.loads(result.content)
        self.assertEqual(payload["results"], [{
            "title": "Python & docs", "url": "https://docs.python.org/", "snippet": "Official docs",
        }])

    async def test_invalid_urls_and_duplicates_are_excluded(self):
        result = await self.call(lambda request: httpx.Response(200, text='''<rss><channel>
            <item><link>file:///secret</link></item><item><link>https://[bad</link></item>
            <item><link>https://example.com/</link></item>
            <item><link>https://example.com/</link></item></channel></rss>'''), query="example")
        self.assertEqual(len(json.loads(result.content)["results"]), 1)

    async def test_empty_results(self):
        result = await self.call(lambda request: httpx.Response(200, text="<rss><channel/></rss>"), query="none")
        self.assertFalse(result.is_error)
        self.assertEqual(json.loads(result.content)["results"], [])

    async def test_failures_are_errors(self):
        for status, body in [(429, "busy"), (302, "redirect"), (200, "<html>challenge</html>"),
                             (200, "<rss"), (200, '<!DOCTYPE rss><rss><channel/></rss>'),
                             (200, "x" * 1_000_001)]:
            with self.subTest(status=status, body_size=len(body)):
                result = await self.call(lambda request: httpx.Response(status, text=body), query="test")
                self.assertTrue(result.is_error)
        for error in [httpx.ReadTimeout("timeout"), httpx.ConnectError("offline")]:
            def handler(request):
                raise error
            self.assertTrue((await self.call(handler, query="test")).is_error)

    def test_schema_and_default_registration(self):
        for arguments in [{"query": " "}, {"query": "x", "max_results": 11}, {"query": "x" * 501}]:
            with self.assertRaises(ValidationError):
                WebSearchInput(**arguments)
        self.assertIn("web_search", {tool.name for tool in create_default_tool_registry().definitions()})
