/** MCP client to the Python engine (streamable HTTP at <engine>/mcp/). */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serviceToken } from "./security.js";

export type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { destructiveHint?: boolean } };

export class EngineMcp {
  private client: Client | null = null;
  tools: McpTool[] = [];
  private connecting: Promise<void> | null = null;
  constructor(private engineUrl: string) {}

  async connect(): Promise<void> {
    const client = new Client({ name: "tiphys-agent", version: "0.1.0" });
    try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${this.engineUrl}/mcp/`),
      { requestInit: { headers: { Authorization: `Bearer ${serviceToken}` } } }));
    const res = await client.listTools();
    this.tools = res.tools as McpTool[];
    this.client = client;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  async ensure(): Promise<void> {
    if (!this.client) {
      this.connecting ??= this.connect().finally(() => { this.connecting = null; });
      await this.connecting;
    }
  }

  /** Call a tool; returns structured JSON (structuredContent or parsed text). No client-side timeout beyond SDK default per request. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    await this.ensure();
    try {
      const res: any = await this.client!.callTool({ name, arguments: args }, undefined, { signal, timeout: 10 * 60_000 });
      if (res.isError) {
        const t = (res.content || []).map((c: any) => c.text).join("\n");
        throw new Error(t || `tool ${name} failed`);
      }
      if (res.structuredContent) {
        const sc = res.structuredContent;
        return sc && typeof sc === "object" && "result" in sc && Object.keys(sc).length === 1 ? sc.result : sc;
      }
      const text = (res.content || []).map((c: any) => c.text ?? "").join("\n");
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    } catch (err) {
      // Reconnect once on transport failure (engine restart).
      if (String(err).match(/fetch failed|ECONNREFUSED|session|connection closed|not connected/i)) {
        const client = this.client;
        this.client = null;
        await client?.close().catch(() => {});
      }
      throw err;
    }
  }
}
