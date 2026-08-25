import assert from 'node:assert/strict';
import test from 'node:test';
import { BraveSearchMcp, braveMcpConfigFromEnv } from './mcp-service.js';

test('BraveSearchMcp exposes and calls only configured tools', async () => {
  const calls = [];
  const logs = [];
  const mcp = new BraveSearchMcp({
    enabled: true,
    url: 'https://brave.example/mcp',
    authorizationHeader: 'Authorization',
    authorization: 'Bearer secret',
    allowedTools: ['web_search'],
    timeoutMs: 1000,
  }, (event, details) => logs.push({ event, details }), () => ({
    client: {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({ tools: [
        { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object' } },
        { name: 'write_data', description: 'Must not be exposed', inputSchema: { type: 'object' } },
      ] }),
      callTool: async (request, _schema, options) => {
        calls.push({ request, options });
        return { content: [{ type: 'text', text: 'headline' }] };
      },
    },
    transport: {},
  }));

  assert.deepEqual(await mcp.functionTools(), [{
    type: 'function', name: 'web_search', description: 'Search the web', parameters: { type: 'object' },
  }]);
  assert.equal(await mcp.call('web_search', '{"query":"today"}'), 'headline');
  assert.deepEqual(calls[0].request, { name: 'web_search', arguments: { query: 'today' } });
  assert.equal(calls[0].options.timeout, 1000);
  await assert.rejects(mcp.call('write_data', '{}'), /not allowed/);
  assert.equal(logs[0].event, 'mcp_ready');
});

test('web search environment configuration is opt-in and keeps the allowlist exact', () => {
  const config = braveMcpConfigFromEnv({
    WEB_SEARCH_ENABLED: 'true',
    BRAVE_MCP_SERVER_URL: 'https://brave.example/mcp',
    BRAVE_MCP_AUTHORIZATION: 'Bearer secret',
    BRAVE_MCP_ALLOWED_TOOLS: ' web_search, local_search ',
  });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.allowedTools, ['web_search', 'local_search']);
  assert.equal(config.authorizationHeader, 'Authorization');
});
