/**
 * Attribution for baseline tool-call events.
 *
 * The browser Agent has two ways to reach the same WASM tool:
 *   - a curated tool id (`wasm_basins`), or
 *   - the generic dispatcher `run_browser_tool({ name: "wasm_basins", ... })`.
 * The desktop Agent reaches it through `wasm_run({ tool: "basins" })`.
 *
 * Success criteria are written in terms of the concrete tool id. Without this
 * attribution a task that really ran `wasm_basins` fails the `tool_called`
 * gate just because the model used the generic entry point.
 */

export type BaselineToolCall = {
  type?: string;
  toolName?: string;
  input?: Record<string, any> | null;
};

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/** Concrete tool ids represented by one event, generic dispatcher included. */
export function toolCallNames(event: BaselineToolCall | null | undefined): string[] {
  if (!event || event.type !== "tool-call") return [];
  const name = stringField(event.toolName);
  if (!name) return [];
  const names = new Set<string>([name]);
  const input = event.input ?? {};
  if (name === "run_browser_tool") {
    const inner = stringField(input.name);
    if (inner) names.add(inner);
  } else if (name === "wasm_run") {
    const inner = stringField(input.tool);
    if (inner) names.add(`wasm_${inner}`);
  } else if (name === "run_plan") {
    const steps = Array.isArray(input.plan?.steps) ? input.plan.steps : [];
    for (const step of steps) {
      const tool = stringField(step?.tool);
      if (tool) names.add(tool);
    }
  }
  return [...names];
}

/** True when any event in the trace called the concrete tool id. */
export function calledTool(events: BaselineToolCall[], name: string): boolean {
  return events.some(event => toolCallNames(event).includes(name));
}

/** Display label keeps the dispatcher visible: run_browser_tool(wasm_basins). */
export function toolCallLabel(event: BaselineToolCall): string {
  const names = toolCallNames(event);
  if (!names.length) return "";
  const [outer, ...inner] = names;
  return inner.length ? `${outer}(${inner.join(",")})` : outer;
}
