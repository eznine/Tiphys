/** JSONL event log per session (Codex rollout-style). Last `checkpoint` line restores messages + workspace. */
import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { TIPHYS_DIR } from "./config.js";
import { emptyWorkspace, type Workspace } from "./context.js";

export type AgentEvent = { type: string; ts?: number; [k: string]: unknown };

export class Session {
  messages: ModelMessage[] = [];
  workspace: Workspace = emptyWorkspace();
  file: string;
  busy = false;
  constructor(public id: string) {
    const dir = path.join(TIPHYS_DIR, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${id.replace(/[^\w.-]/g, "_")}.jsonl`);
    this.restore();
  }
  private restore() {
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.type === "checkpoint") {
          this.messages = e.messages;
          this.workspace = { ...emptyWorkspace(), ...e.workspace };
          return;
        }
      } catch {
        /* skip */
      }
    }
  }
  append(e: AgentEvent) {
    fs.appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...e }) + "\n");
  }
  checkpoint() {
    this.append({ type: "checkpoint", messages: this.messages, workspace: this.workspace });
  }
  /** UI-facing events (no checkpoints) for replay on reconnect. */
  events(): AgentEvent[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .trim()
      .split("\n")
      .flatMap((l) => {
        try {
          const e = JSON.parse(l);
          return e.type === "checkpoint" || e.type === "text-delta" ? [] : [e];
        } catch {
          return [];
        }
      });
  }
}
