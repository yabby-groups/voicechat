import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MAX_TOOL_OUTPUT_CHARS = 12000;

function truncate(value, limit = MAX_TOOL_OUTPUT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[Tool output truncated]`;
}

function resultText(result) {
  if (result?.structuredContent) return JSON.stringify(result.structuredContent);
  if (Array.isArray(result?.content)) {
    return result.content.map((item) => {
      if (item.type === 'text') return item.text;
      if (item.type === 'resource' && item.resource?.text) return item.resource.text;
      return JSON.stringify(item);
    }).join('\n');
  }
  return JSON.stringify(result ?? {});
}

export class BraveSearchMcp {
  constructor(config, log = () => undefined, createClient = defaultClientFactory) {
    this.config = config;
    this.log = log;
    this.createClient = createClient;
    this.client = null;
    this.tools = [];
    this.ready = null;
  }

  enabled() {
    return Boolean(this.config?.enabled);
  }

  async functionTools() {
    if (!this.enabled()) return [];
    await this.initialize();
    return this.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description || `Search the web using ${tool.name}.`,
      parameters: tool.inputSchema,
    }));
  }

  async call(name, rawArguments, onActivity) {
    await this.initialize();
    if (!this.tools.some((tool) => tool.name === name)) {
      throw new Error('The requested web search tool is not allowed.');
    }
    let args;
    try {
      args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
    } catch {
      throw new Error('The model supplied invalid arguments for the web search tool.');
    }
    const startedAt = performance.now();
    onActivity?.({ type: 'tool_call', label: 'Brave Search', name });
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.config.timeoutMs,
      });
      const output = truncate(resultText(result));
      this.log('mcp_complete', `tool=${name} duration_ms=${Math.round(performance.now() - startedAt)} error=${Boolean(result?.isError)}`);
      return result?.isError ? JSON.stringify({ error: output }) : output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('mcp_failed', `tool=${name} duration_ms=${Math.round(performance.now() - startedAt)} error=${JSON.stringify(truncate(message, 300))}`);
      return JSON.stringify({ error: 'Web search is temporarily unavailable.' });
    }
  }

  async close() {
    await this.client?.close();
    this.client = null;
    this.ready = null;
    this.tools = [];
  }

  async initialize() {
    if (this.ready) return this.ready;
    this.ready = this.connect();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async connect() {
    if (!this.config.url || !this.config.authorization) {
      throw new Error('Web search is enabled but the Brave MCP server configuration is incomplete.');
    }
    const { client, transport } = this.createClient(this.config);
    await client.connect(transport);
    const result = await client.listTools({});
    const allowed = new Set(this.config.allowedTools);
    this.tools = (result.tools || []).filter((tool) => allowed.has(tool.name));
    if (!this.tools.length) {
      await client.close();
      throw new Error('The Brave MCP server did not expose any allowed search tools.');
    }
    this.client = client;
    this.log('mcp_ready', `tools=${this.tools.map((tool) => tool.name).join(',')}`);
  }
}

function defaultClientFactory(config) {
  const client = new Client({ name: 'echo-voicechat', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: { [config.authorizationHeader]: config.authorization },
    },
  });
  return { client, transport };
}

export function braveMcpConfigFromEnv(env = process.env) {
  const enabled = env.WEB_SEARCH_ENABLED === 'true';
  return {
    enabled,
    url: env.BRAVE_MCP_SERVER_URL || '',
    authorizationHeader: env.BRAVE_MCP_AUTHORIZATION_HEADER || 'Authorization',
    authorization: env.BRAVE_MCP_AUTHORIZATION || '',
    allowedTools: (env.BRAVE_MCP_ALLOWED_TOOLS || '').split(',').map((value) => value.trim()).filter(Boolean),
    timeoutMs: Number(env.MCP_TOOL_TIMEOUT_MS || 10000),
  };
}
