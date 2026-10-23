import fs from "node:fs";
import path from "node:path";
const dir = process.env.TIPHYS_STATE_DIR || path.resolve(".tiphys");
const token = process.env.TIPHYS_SERVICE_TOKEN || fs.readFileSync(path.join(dir, "service-token"), "utf8").trim();
const response = await fetch(`http://127.0.0.1:${process.env.TIPHYS_AGENT_PORT || 8972}/tools`, { headers: { Authorization: `Bearer ${token}` } });
if (!response.ok) throw new Error(`Agent tools request failed (${response.status})`);
console.log(JSON.stringify(await response.json(), null, 2));
