/**
 * Stage 4 A/B report generator: compares two agent-baseline runs (arm A =
 * direct tools + static 8-step cap; arm B = budgets + planning prompt) on the
 * same 30 fixed tasks and success criteria. Reads the frozen JSON reports;
 * writes docs/baselines/stage4/agent-ab.md. Numbers never merge with
 * GeoAgentBench or engine-reference baselines.
 *
 *   npm run compare:arms
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "docs", "baselines", "stage4");
const ARM_FILES = ["agent-baseline.json", "agent-baseline-planned.json"];

type ArmResult = {
  task: string; status: string; duration_ms: number; tool_calls: string[];
  expected_tool_hit: boolean; usage: { input: number; output: number };
  criteria: { severity?: string; ok: boolean }[];
  fatal?: string | null;
};
type Arm = { generated_at: string; arm: string; model: { name?: string }; totals: { tasks: number; pass: number; fail: number; error: number; expected_tool_hit: number; usage: { input: number; output: number } }; results: ArmResult[] };

function load(name: string): Arm {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("只接受简单文件名：" + name);
  const file = path.join(DIR, name);
  if (!file.startsWith(DIR + path.sep) || !fs.existsSync(file)) throw new Error("找不到 " + name + "（先跑对应的 baseline:agent 臂）。");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Arm;
}

const a = load(ARM_FILES[0]);
const b = load(ARM_FILES[1]);
const byTask = (arm: Arm) => new Map(arm.results.map(r => [r.task, r]));
const mapA = byTask(a), mapB = byTask(b);
const tasks = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

const p50 = (values: number[]) => { const s = [...values].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const changedDirection = (ra: ArmResult | undefined, rb: ArmResult | undefined) => {
  if (!ra || !rb) return "";
  if (ra.status === rb.status) return "";
  return rb.status === "PASS" ? "↑ 修复" : ra.status === "PASS" ? "↓ 回退" : "?";
};

const lines = [
  "# 阶段 4 · A/B 对照：直接工具+8 步上限 vs 预算制+规划提示词", "",
  `> A 臂：${a.generated_at}（arm=${a.arm}）· B 臂：${b.generated_at}（arm=${b.arm}）· 同一 30 任务与判据（agent-success.json）· 同一模型 ${a.model?.name ?? "?"}`,
  "> 单次运行/任务；差异方向有意义，差值本身有方差（见 NOT_TESTED）。", "",
  "| 指标 | A 臂（基线） | B 臂（预算+规划） | Δ |", "|---|---|---|---|",
  `| 任务成功 | ${a.totals.pass}/${a.totals.tasks} | ${b.totals.pass}/${b.totals.tasks} | ${b.totals.pass - a.totals.pass >= 0 ? "+" : ""}${b.totals.pass - a.totals.pass} |`,
  `| 预期工具命中 | ${a.totals.expected_tool_hit}/${a.totals.tasks} | ${b.totals.expected_tool_hit}/${b.totals.tasks} | ${b.totals.expected_tool_hit - a.totals.expected_tool_hit >= 0 ? "+" : ""}${b.totals.expected_tool_hit - a.totals.expected_tool_hit} |`,
  `| P50 耗时 | ${Math.round(p50(a.results.map(r => r.duration_ms)) / 1000)} s | ${Math.round(p50(b.results.map(r => r.duration_ms)) / 1000)} s | |`,
  `| tokens（输入/输出） | ${a.totals.usage.input}/${a.totals.usage.output} | ${b.totals.usage.input}/${b.totals.usage.output} | ${b.totals.usage.input - a.totals.usage.input >= 0 ? "+" : ""}${b.totals.usage.input - a.totals.usage.input} 输入 |`,
  `| 平均工具调用数 | ${(a.results.reduce((s, r) => s + r.tool_calls.length, 0) / Math.max(a.results.length, 1)).toFixed(1)} | ${(b.results.reduce((s, r) => s + r.tool_calls.length, 0) / Math.max(b.results.length, 1)).toFixed(1)} | |`,
  "", "## 逐任务", "",
  "| 任务 | A | B | 变化 | B 臂工具链 |", "|---|---|---|---|---|",
];
for (const task of tasks) {
  const ra = mapA.get(task), rb = mapB.get(task);
  lines.push(`| ${task} | ${ra?.status ?? "—"} | ${rb?.status ?? "—"} | ${changedDirection(ra, rb)} | ${(rb?.tool_calls ?? []).join("→").slice(0, 80) || "—"} |`);
}
const bRunPlan = b.results.filter(r => r.tool_calls.includes("run_plan")).length;
lines.push("", `B 臂使用 run_plan 的任务：**${bRunPlan}/${b.totals.tasks}**（A 臂 0）。`, "");
const flips = tasks.filter(t => mapA.get(t)?.status !== mapB.get(t)?.status);
if (flips.length) {
  lines.push("## 状态翻转的任务", "");
  for (const task of flips) {
    const ra = mapA.get(task), rb = mapB.get(task);
    lines.push(`- **${task}**：${ra?.status} → ${rb?.status}${rb && rb.status !== "PASS" ? "（未过判据：" + (rb.criteria ?? []).filter(c => !c.ok).map(c => c.severity === "warn" ? "warn" : "gate").join(", ") + "）" : ""}`);
    if (rb?.fatal) lines.push(`  - B 臂驱动器错误：${String(rb.fatal).slice(0, 120)}`);
  }
  lines.push("");
}
lines.push("## NOT_TESTED", "", "- 每任务单次运行，未做 ≥3 次方差；", "- 两臂之间模型服务侧波动未隔离（同一模型与 key，但不同时段）；", "- GeoAgentBench 子集单列，不并入本对照。", "");
fs.writeFileSync(path.join(DIR, "agent-ab.md"), lines.join("\n") + "\n");
console.log("wrote docs/baselines/stage4/agent-ab.md  A=" + a.totals.pass + "/" + a.totals.tasks + "  B=" + b.totals.pass + "/" + b.totals.tasks + "  run_plan×" + bRunPlan);
