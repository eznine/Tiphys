/** Deterministic mock LanguageModelV3 so the loop + MCP tools can be demoed without an API key. */
import { MockLanguageModelV3 } from "ai/test";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

type Part = any;
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function textParts(text: string): Part[] {
  const chunks = text.match(/.{1,8}/gsu) ?? [text];
  return [
    { type: "text-start", id: "t" },
    ...chunks.map((delta) => ({ type: "text-delta", id: "t", delta })),
    { type: "text-end", id: "t" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
  ];
}
function callParts(toolName: string, input: unknown): Part[] {
  return [
    { type: "tool-call", toolCallId: `call_${Math.random().toString(36).slice(2, 10)}`, toolName, input: JSON.stringify(input) },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
  ];
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((c: any) => c.text ?? "").join("");
}

function decide(prompt: any[]): Part[] {
  const last = prompt[prompt.length - 1];
  const lastUser = [...prompt].reverse().find((m) => m.role === "user");
  const userText = textOf(lastUser?.content);
  const system = prompt.find((m) => m.role === "system")?.content ?? "";
  const dm = userText.match(/(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)/i);
  const distance = dm ? Number(dm[1]) * (/公里|千米|km/i.test(dm[2]) ? 1000 : 1) : 500;

  if (last.role === "tool") {
    const tr = last.content[last.content.length - 1];
    const out = tr.output?.value ?? {};
    if (tr.output?.type === "error-text" || tr.output?.type === "error-json" || out?.denied)
      return textParts(`工具 ${tr.toolName} 未执行：${JSON.stringify(out).slice(0, 200)}`);
    switch (tr.toolName) {
      case "add_data":
        return callParts("buffer", { layer: out.layer.id, distance, units: "meters" });
      case "buffer":
        return textParts(
          `已加载 samples 点图层，并提交 ${distance} 米缓冲任务（job_id: ${out.job_id}）。进度显示在下方任务卡片里，可随时取消；完成后结果图层会自动加到地图和图层列表。`,
        );
      case "list_layers":
        return textParts(
          out.layers?.length ? "当前图层：\n" + out.layers.map((l: any) => `- ${l.name} (${l.id}, ${l.feature_count} 要素, ${l.crs})`).join("\n") : "工作区还没有图层。",
        );
      case "remove_layer":
        return textParts(`已删除图层 ${out.name ?? out.removed}。`);
      default:
        return textParts(`完成：${JSON.stringify(out).slice(0, 300)}`);
    }
  }

  if (/缓冲|buffer/i.test(userText)) return callParts("add_data", { path: path.join(PROJECT_ROOT, "samples/beijing_points.geojson") });
  if (/删除|remove|delete/i.test(userText)) {
    const m = system.match(/"id":"(lyr_[0-9a-f]+)","name":"([^"]+)"/g);
    const target = m?.length ? m[m.length - 1].match(/lyr_[0-9a-f]+/)![0] : "none";
    return callParts("remove_layer", { layer: target });
  }
  if (/图层|layers?\b|list/i.test(userText)) return callParts("list_layers", {});
  if (/ping/i.test(userText)) return callParts("ping", {});
  return textParts("（mock 模型）我可以：给 samples 里的点做 500 米缓冲 / 列出图层 / 删除最后一个图层 / ping。配置 TIPHYS_LLM_* 环境变量即可换成真实模型。");
}

export function createMockModel() {
  return new MockLanguageModelV3({
    provider: "tiphys-mock",
    modelId: "mock-gis",
    doStream: async ({ prompt }: any) => {
      const parts = decide(prompt);
      return {
        stream: new ReadableStream({
          async start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            for (const p of parts) {
              c.enqueue(p);
              await new Promise((r) => setTimeout(r, 25));
            }
            c.close();
          },
        }),
      } as any;
    },
  });
}
