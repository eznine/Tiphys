import { useEffect, useMemo, useState } from "react";
import type { DataLayer } from "../lib/dataLayers";
import { browserEngineRequest } from "../lib/browser/engine";
import { TASK_CARDS, buildTaskRecipe, cardById, suggestDraft, slotMatches, taskRecipeFilename, taskRecipeJson, type CardDraft, type CardLayerFacts, type CardReady } from "../lib/taskCards";
import { CircleCheck, CircleAlert, Play, X, Download, FileJson, ListChecks } from "lucide-react";

/**
 * Preset task cards (stage 4): one tap from a natural-language sentence to an
 * audited local-WASM plan run. Shared by the desktop chat dock and the mobile
 * chat sheet — same cards, same engine, same acceptance record. The chat agent
 * remains the path for anything these cards do not cover.
 */

type RunSummary = {
  ok?: boolean; run_id?: string; status?: string; headline?: string;
  deliverables?: { stepId: string; layerId: string; name: string }[];
  blocked_at?: { stepId: string; label: string; errorClass: string; message: string; next: string[] } | null;
  steps?: { stepId: string; label: string; phase: string; acceptance?: { type: string; ok: boolean; detail: string }[]; error?: { class: string; message: string } | null }[];
  plan_issues?: { stepId: string | null; class: string; message: string }[];
};

export type TaskCardEvent =
  | { type: "start"; taskId: string; cardId: string; title: string; goal: string; plan: unknown }
  | { type: "finish"; taskId: string; cardId: string; summary?: RunSummary; error?: string };

const toFacts = (layers: DataLayer[]): CardLayerFacts[] => layers.map(layer => ({
  id: layer.id, name: layer.name, kind: layer.kind ?? "vector", crs: layer.crs,
  featureCount: layer.feature_count, geometryTypes: layer.geometry_types, raster: layer.raster ?? null,
}));

async function runEngineTool(name: string, args: Record<string, unknown>) {
  const created = await (await browserEngineRequest("/tools/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, arguments: args }) })).json();
  if (!created.job_id) return created;
  for (let attempt = 0; attempt < 1200; attempt++) {
    const job = await (await browserEngineRequest("/jobs/" + created.job_id)).json();
    if (!["queued", "running", "cancelling"].includes(job.status)) {
      if (job.status !== "completed") throw new Error(job.error || job.message || "任务失败");
      return job.result;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("任务超出观察预算");
}

export function TaskCards({ layers, selectedLayerId, busy, onTask, allowRecipeExport = false }: {
  layers: DataLayer[]; selectedLayerId?: string | null; busy?: boolean; onTask?: (event: TaskCardEvent) => void; allowRecipeExport?: boolean;
}) {
  const facts = useMemo(() => toFacts(layers), [layers]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CardDraft>>({});
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<{ cardId: string; summary: RunSummary } | null>(null);
  const [exportState, setExportState] = useState<{ url: string; name: string } | null>(null);
  const [exportError, setExportError] = useState("");
  const [recipeNotice, setRecipeNotice] = useState("");

  const open = openId ? cardById(openId) : null;
  const draft = open ? drafts[open.id] ?? suggestDraft(open, facts, selectedLayerId) : null;
  useEffect(() => { setResult(null); setRunError(""); setExportState(null); setExportError(""); setRecipeNotice(""); }, [openId]);

  // Field list for presets that need a numeric field (field statistics).
  useEffect(() => {
    if (!open || !draft || !open.needsField) return;
    const layerId = draft.inputs[open.slots[0].key];
    if (!layerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const described = await runEngineTool("describe_layer", { layer: layerId });
        const columns: string[] = described.columns ?? [];
        if (cancelled) return;
        setFields(current => ({ ...current, [layerId]: columns }));
        // Suggest the first numeric-looking column once; the user can change it.
        setDrafts(current => {
          const existing = current[open.id];
          if (!existing || existing.field) return current;
          const preferred = columns.find(name => /^(pop|value|count|area|length|num|score|id)$/i.test(name)) ?? columns.find(name => /pop|值|数|area|length/i.test(name)) ?? columns[0];
          return preferred ? { ...current, [open.id]: { ...existing, field: preferred } } : current;
        });
      } catch { /* the form falls back to a free-text field name */ }
    })();
    return () => { cancelled = true; };
  }, [open?.id, open?.needsField, draft?.inputs[open?.slots[0]?.key ?? ""]]);

  if (!TASK_CARDS.length) return null;
  const built = open && draft ? open.build(draft, facts) : null;

  const update = (patch: Partial<CardDraft>) => {
    if (!open || !draft) return;
    const next = { ...draft, ...patch };
    if (!patch.goal) next.goal = open.defaultGoal(next, facts);
    setDrafts(current => ({ ...current, [open.id]: next }));
    setRecipeNotice("");
  };

  const run = async () => {
    if (!open || !draft || !built?.ok) return;
    const taskId = `plan-${crypto.randomUUID()}`;
    setRunning(open.id); setRunError(""); setResult(null); setExportState(null); setExportError("");
    onTask?.({ type: "start", taskId, cardId: open.id, title: open.title, goal: built.plan.goal, plan: built.plan });
    try {
      const summary = await runEngineTool("run_plan", { plan: built.plan }) as RunSummary;
      setResult({ cardId: open.id, summary });
      onTask?.({ type: "finish", taskId, cardId: open.id, summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunError(message);
      onTask?.({ type: "finish", taskId, cardId: open.id, error: message });
    } finally { setRunning(null); }
  };

  const exportRecipe = () => {
    if (!open || !draft || !built?.ok) return;
    try {
      const recipe = buildTaskRecipe(open, draft, facts, built.plan);
      const filename = taskRecipeFilename(open.id);
      const blob = new Blob([taskRecipeJson(recipe)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 500);
      setRecipeNotice(`已导出方案 JSON「${filename}」，未执行任何工具。`);
    } catch (error) {
      setRecipeNotice(`方案导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportResult = async (layerId: string, name: string) => {
    setExportError("");
    try {
      const path = (name.replace(/[\\/:*?"<>|]/g, "_")) + ".geojson";
      const exported = await runEngineTool("export_features", { layer: layerId, path, fmt: "geojson" });
      if (exported?.download_url) setExportState({ url: exported.download_url as string, name: String(exported.path ?? path) });
      else setExportError(exported?.message ? String(exported.message) : "导出未返回下载链接。");
    } catch (error) { setExportError(error instanceof Error ? error.message : String(error)); }
  };

  return (
    <section className="task-cards" aria-label="任务卡：本地执行并验收">
      <div className="workflow-heading"><span><ListChecks size={13} />任务卡 · 本地 WASM 执行</span><small>预设任务直接跑：执行前说明引擎与预算，跑完给验收结论</small></div>
      <div className="workflow-grid">
        {TASK_CARDS.map(card => {
          const available = card.slots.every(slot => facts.some(layer => slotMatches(layer, slot.kind, slot.geometry)));
          return (
            <button key={card.id} type="button" className="workflow-card task-card" disabled={busy || running === card.id}
              data-open={openId === card.id || undefined} data-available={available || undefined}
              onClick={() => {
                // Seed the draft on first open so async suggestions (field list)
                // have a stable place to land.
                setDrafts(current => current[card.id] ? current : { ...current, [card.id]: suggestDraft(card, facts, selectedLayerId) });
                setOpenId(openId === card.id ? null : card.id);
              }}>
              <ListChecks size={16} strokeWidth={1.7} />
              <strong>{card.title}</strong><small>{available ? card.detail : "缺少合适图层"}</small>
            </button>
          );
        })}
      </div>

      {open && draft && (
        <div className="task-card-panel" role="group" aria-label={`${open.title} 任务卡`}>
          <div className="task-card-goal">
            <label>任务描述（可改）<textarea rows={2} value={draft.goal} onChange={event => update({ goal: event.target.value })} /></label>
          </div>
          <div className="task-card-form">
            {open.slots.map(slot => (
              <label key={slot.key}>{slot.label}
                <select value={draft.inputs[slot.key] ?? ""} onChange={event => update({ inputs: { ...draft.inputs, [slot.key]: event.target.value } })}>
                  <option value="">选择图层…</option>
                  {facts.filter(layer => slotMatches(layer, slot.kind, slot.geometry)).map(layer => (
                    <option key={layer.id} value={layer.id}>{layer.name}（{layer.featureCount ?? "?"} {layer.kind === "raster" ? "像元图" : "要素"}）</option>
                  ))}
                </select>
              </label>
            ))}
            {open.needsNumeric && (
              <label>{open.needsNumeric.label}（{open.needsNumeric.unit}）
                <input type="number" min={open.needsNumeric.min} max={open.needsNumeric.max} value={draft.numeric ?? open.needsNumeric.default}
                  onChange={event => update({ numeric: Number(event.target.value) })} />
              </label>
            )}
            {open.needsField && (() => {
              const layerId = draft.inputs[open.slots[0].key];
              const options = fields[layerId] ?? [];
              return (
                <label>数值字段
                  <select value={draft.field ?? ""} onChange={event => update({ field: event.target.value })}>
                    <option value="">{options.length ? "选择字段…" : "输入或稍候…"}</option>
                    {options.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
              );
            })()}
          </div>

          {built && !built.ok && (
            <p className="task-card-blocked" role="alert"><CircleAlert size={13} /> {built.reason}<small>{built.degrade}</small></p>
          )}
          {built?.ok && (
            <div className="task-card-explain">
              <p><strong>{(built as CardReady).explanation.engine}</strong></p>
              <p>{(built as CardReady).explanation.estimate}</p>
              {(built as CardReady).explanation.budget && <p>{(built as CardReady).explanation.budget}</p>}
              <ol className="task-card-steps">
                {(built as CardReady).plan.steps.map(stepItem => <li key={stepItem.id}>{stepItem.title ?? stepItem.id}：{stepItem.kind === "operation" ? stepItem.spec.operation : stepItem.tool}</li>)}
              </ol>
            </div>
          )}

          <div className="task-card-actions">
            {allowRecipeExport && <button type="button" className="icon-btn" disabled={!built?.ok}
              aria-label="导出任务方案 JSON，不执行" title="导出当前表单与计划预览；不会自动执行" onClick={exportRecipe}>
              <FileJson size={12} /> 导出方案
            </button>}
            <button type="button" className="primary-btn" disabled={!built?.ok || running !== null || busy} onClick={() => void run()}>
              {running === open.id ? "执行中…" : <><Play size={12} /> 本地执行</>}
            </button>
            <button type="button" className="icon-btn" aria-label="收起任务卡" onClick={() => setOpenId(null)}><X size={12} /></button>
          </div>

          {recipeNotice && <p className="task-card-recipe-notice" role="status">{recipeNotice}</p>}

          {runError && <p className="task-card-error" role="alert">{runError}</p>}
          {result && result.cardId === open.id && (
            <div className="task-card-result" data-status={result.summary.status}>
              <div className="task-card-result-head">
                {result.summary.status === "completed" ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
                <strong>{result.summary.headline}</strong>
              </div>
              {(result.summary.plan_issues ?? []).map((issue, index) => (
                <p key={index} className="task-card-issue">{issue.class}：{issue.message}</p>
              ))}
              {(result.summary.steps ?? []).map(stepItem => (
                <div key={stepItem.stepId} className="task-card-step" data-phase={stepItem.phase}>
                  <code>{stepItem.stepId}</code>
                  <span>{stepItem.label} · {stepItem.phase}{stepItem.error ? ` · ${stepItem.error.class}` : ""}</span>
                  <ul>
                    {(stepItem.acceptance ?? []).map((item, index) => (
                      <li key={index} data-ok={item.ok}>{item.ok ? "✓" : "✗"} {item.detail}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {result.summary.blocked_at?.next?.length ? (
                <p className="task-card-next">下一步：{result.summary.blocked_at.next.join(" ")}</p>
              ) : null}
              {(result.summary.deliverables ?? []).length > 0 && (
                <div className="task-card-deliverables">
                  {result.summary.deliverables!.map(item => (
                    <button key={item.layerId} type="button" className="icon-btn" onClick={() => void exportResult(item.layerId, item.name)}>
                      <Download size={12} /> 导出 {item.name}
                    </button>
                  ))}
                </div>
              )}
              {exportState && <p className="task-card-export"><a href={exportState.url} download={exportState.name}>{exportState.name} 已就绪，点击下载</a></p>}
              {exportError && <p className="task-card-error">{exportError}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
