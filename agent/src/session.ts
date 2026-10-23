/** Durable events plus a separate atomic checkpoint; legacy JSONL checkpoints remain readable. */
import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { TIPHYS_DIR } from "./config.js";
import { emptyWorkspace, type Workspace } from "./context.js";

export type AgentEvent = { type: string; ts?: number; seq?: number; [k: string]: unknown };

export class Session {
  messages: ModelMessage[] = [];
  workspace: Workspace = emptyWorkspace();
  file: string;
  busy = false;
  controller: AbortController | null = null;
  private history: AgentEvent[] = [];
  private cursor = 0;
  private checkpointFile: string;
  private log: fs.WriteStream;

  constructor(public id: string, root = TIPHYS_DIR) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid session id");
    const dir = path.join(root, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${id}.jsonl`);
    this.checkpointFile = path.join(dir, `${id}.checkpoint.json`);
    let saved: any;
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.type === "checkpoint") saved = e;
          else {
            this.cursor = Math.max(this.cursor + 1, e.seq ?? 0);
            this.history.push({ ...e, seq: this.cursor });
          }
        } catch { /* A crash can leave a partial last event. */ }
      }
    }
    if (fs.existsSync(this.checkpointFile)) saved = JSON.parse(fs.readFileSync(this.checkpointFile, "utf8"));
    if (saved) {
      this.messages = saved.messages;
      this.workspace = { ...emptyWorkspace(), ...saved.workspace };
      this.cursor = Math.max(this.cursor, saved.cursor ?? 0);
    }
    if (fs.existsSync(this.file) && fs.statSync(this.file).size > 0 && !fs.readFileSync(this.file, "utf8").endsWith("\n"))
      fs.appendFileSync(this.file, "\n");
    this.log = fs.createWriteStream(this.file, { flags: "a" });
    const lastUser = this.history.findLastIndex(e => e.type === "user");
    const lastEnd = this.history.findLastIndex(e => e.type === "turn-end");
    if (lastUser > lastEnd) {
      this.append({ type: "notice", text: "上次对话因 Agent 重启中断；已执行的工具不会自动重试，请先检查工作区。" });
      this.append({ type: "turn-end", interrupted: true });
    }
  }

  append(e: AgentEvent): AgentEvent {
    const ev = { ...e, ts: e.ts ?? Date.now(), seq: ++this.cursor };
    this.history.push(ev);
    this.log.write(JSON.stringify(ev) + "\n");
    return ev;
  }

  checkpoint() {
    const tmp = this.checkpointFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ messages: this.messages, workspace: this.workspace, cursor: this.cursor }));
    fs.renameSync(tmp, this.checkpointFile);
  }

  get lastSeq() { return this.cursor; }
  events(after = 0): AgentEvent[] { return this.history.filter(e => (e.seq ?? 0) > after); }
  close(): Promise<void> { return new Promise((resolve, reject) => { this.log.on("error", reject); this.log.end(resolve); }); }
}
