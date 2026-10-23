import { CheckCircle2 } from "lucide-react";

type PipelineStep = { tool?: string; step?: string; layer?: string; status?: string; message?: string };

function unwrap(output: unknown): Record<string, any> | null {
  let value = output as any;
  if (value && typeof value === "object" && "value" in value && "type" in value) value = value.value;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" ? value : null;
}

export function pipelineResult(output: unknown): Record<string, any> | null {
  const result = unwrap(output);
  return result && Array.isArray(result.steps) && result.steps.length ? result : null;
}

export function PipelineResultDetails({ output }: { output: unknown }) {
  const result = pipelineResult(output);
  if (!result) return null;
  const layers = [
    ...(result.layer ? [result.layer] : []),
    ...(Array.isArray(result.layers) ? result.layers.map((item: any) => item?.layer).filter(Boolean) : []),
  ];
  const names = new Map(layers.map((layer: any) => [String(layer.id), String(layer.name)]));
  const steps = result.steps as PipelineStep[];
  return <div className="pipeline-result">
    <div className="pipeline-result-head"><span><CheckCircle2 size={12} />流程结果 · {steps.length} 步</span>{layers.length > 0 && <small>{layers.length} 个结果图层</small>}</div>
    <ol className="pipeline-steps">
      {steps.map((step, index) => <li key={`${step.tool ?? "step"}-${index}`} data-status={step.status ?? "completed"}>
        <span className="pipeline-index">{index + 1}</span>
        <span className="pipeline-step-copy"><strong>{step.step ?? step.tool ?? `步骤 ${index + 1}`}</strong>
          <small>{step.layer && names.get(String(step.layer)) ? names.get(String(step.layer)) : step.tool ?? ""}</small></span>
        <span className="pipeline-step-state">{step.status === "completed" ? "完成" : step.status ?? "完成"}</span>
      </li>)}
    </ol>
    {result.limitations && <p className="pipeline-limitations" title={String(result.limitations)}>{String(result.limitations)}</p>}
  </div>;
}
