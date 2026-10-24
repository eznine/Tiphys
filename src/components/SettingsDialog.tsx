import { useEffect, useRef, useState } from "react";
import { Settings2, Server, Palette, SlidersHorizontal, Info, X, Eye, EyeOff, Check, Sun, Moon, Monitor, PlugZap, LoaderCircle, RefreshCw } from "lucide-react";
import { agentRequest } from "../lib/service";
import { matchProviderPreset, PROVIDER_PRESETS } from "../lib/defaults";

export type ThemeMode = "light" | "dark" | "system";
type Settings = { provider: string; baseURL: string; model: string; hasApiKey: boolean; keyCount: number; keySource: string;
  contextWindow: number; maxToolOutputChars: number; configIssue: string; configPath: string; backupPath: string; environmentOverrides: string[] };
export function SettingsDialog({ theme, onTheme, density, onDensity, onClose, onSaved, onLogs }: {
  theme: ThemeMode; onTheme: (mode: ThemeMode) => void; density: "standard" | "compact"; onDensity: (value: "standard" | "compact") => void;
  onClose: () => void; onSaved: () => void; onLogs: () => void;
}) {
  const [tab, setTab] = useState("api");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [providerKey, setProviderKey] = useState("custom");
  const [models, setModels] = useState<string[]>([]);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [contextWindow, setContextWindow] = useState(64000);
  const [maxOutput, setMaxOutput] = useState(6000);
  const [pending, setPending] = useState<"test" | "save" | "models" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void agentRequest("/settings", { signal: abort.signal }).then(r => r.json()).then((s: Settings) => {
      if (abort.signal.aborted) return;
      setSettings(s); setBaseURL(s.baseURL); setModel(s.provider === "unconfigured" ? "" : s.model);
      setProviderKey(matchProviderPreset(s.baseURL));
      setContextWindow(s.contextWindow); setMaxOutput(s.maxToolOutputChars);
    }).catch(err => { if (!abort.signal.aborted) setError(String(err)); });
    dialog.current?.focus();
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);
  const submit = async (test: boolean) => {
    setError(""); setMessage(""); setPending(test ? "test" : "save");
    controller.current = new AbortController();
    try {
      const result = await (await agentRequest(test ? "/settings/test" : "/settings", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.current.signal,
        body: JSON.stringify({ baseURL, model, apiKey: key, contextWindow, maxToolOutputChars: maxOutput }),
      })).json();
      if (test) setMessage(`连接成功 · ${result.model} · ${(result.latencyMs / 1000).toFixed(1)} 秒（真实 API 调用）`);
      else { setSettings(result); setKey(""); setMessage("API 配置已保存并立即生效，无需重启。"); onSaved(); }
    } catch (err) { if (!controller.current.signal.aborted) setError(String(err)); }
    finally { setPending(null); }
  };
  const fetchModels = async () => {
    setError(""); setMessage(""); setPending("models");
    controller.current = new AbortController();
    try {
      const result = await (await agentRequest("/settings/models", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.current.signal,
        body: JSON.stringify({ baseURL, apiKey: key }),
      })).json();
      const list: string[] = Array.isArray(result.models) ? result.models : [];
      setModels(list);
      if (!model && list.length) setModel(list[0]);
      setMessage(`已获取 ${list.length} 个模型。在下方列表选择，或直接在模型名称中输入。`);
    } catch (err) { if (!controller.current.signal.aborted) setError(String(err)); }
    finally { setPending(null); }
  };
  const tabs = [{ id: "api", text: "模型与 API", icon: Server }, { id: "appearance", text: "外观", icon: Palette },
    { id: "runtime", text: "运行参数", icon: SlidersHorizontal }, { id: "about", text: "关于与诊断", icon: Info }];
  return <div className="settings-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !pending) onClose(); }}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1} ref={dialog}
      onKeyDown={e => {
        if (e.key === "Escape" && !pending) onClose();
        if (e.key === "Tab") {
          const elements = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)');
          if (!elements?.length) return;
          const first = elements[0], last = elements[elements.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}>
      <header className="settings-header"><div><Settings2 size={19} /><strong>设置</strong><span>TIPHYS 工作区偏好</span></div>
        <button type="button" className="plain-icon" aria-label="关闭设置" disabled={!!pending} onClick={onClose}><X size={18} /></button></header>
      <div className="settings-body"><nav className="settings-nav" aria-label="设置类别">{tabs.map(t => <button key={t.id} type="button" data-active={tab === t.id} onClick={() => setTab(t.id)}><t.icon size={17} />{t.text}</button>)}</nav>
        <div className="settings-content">
          {tab === "api" && <>
            <div className="settings-section-heading"><h2>模型与 API</h2><p>连接你自己的模型服务，让 Agent 使用真实 API 完成任务。</p></div>
            <div className="api-current" data-ready={settings?.provider === "openai-compatible"}><span className="status-dot" data-state={settings?.provider === "openai-compatible" ? "ok" : "error"} /><div><strong>{settings?.provider === "openai-compatible" ? `当前模型：${settings.model}` : settings?.provider === "mock" ? "当前为模拟测试模型（Mock）" : "API 尚未配置"}</strong><span>{settings?.hasApiKey ? `已加载 ${settings.keyCount} 个密钥${settings.keySource ? ` · ${settings.keySource}` : ""}，保留现有凭据即可使用。` : settings?.configIssue || "填写下方配置后保存，应用不会自动使用模拟模型。"}</span></div></div>
            <label className="settings-field"><span>API 服务商</span><select aria-label="API 服务商" value={providerKey} onChange={e => {
              const key = e.target.value, preset = PROVIDER_PRESETS.find(p => p.key === key);
              setProviderKey(key); setModels([]);
              if (preset && preset.key !== "custom") { setBaseURL(preset.baseURL); if (preset.model) setModel(preset.model); }
            }}>{PROVIDER_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select><small>选择后自动填入 OpenAI 兼容接口地址；模型可拉取或手动填写。</small></label>
            <label className="settings-field"><span>API 地址 <b>*</b></span><input aria-label="API 地址" type="url" value={baseURL} onChange={e => { setBaseURL(e.target.value); setProviderKey(matchProviderPreset(e.target.value)); }} placeholder="https://服务地址/v1" /><small>填写服务商的 OpenAI 兼容接口根地址，通常以 /v1 结尾。</small></label>
            <div className="settings-field"><span>模型名称 <b>*</b></span>
              <div className="settings-model-row"><input aria-label="模型名称" list="tiphys-model-options" value={model} onChange={e => setModel(e.target.value)} placeholder="填写服务商提供的模型 ID" /><button type="button" className="icon-btn" aria-label="拉取模型" disabled={!!pending || !settings || !baseURL.trim()} onClick={() => void fetchModels()}>{pending === "models" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}拉取模型</button></div>
              {models.length > 0 && <select aria-label="选择拉取到的模型" value={models.includes(model) ? model : ""} onChange={e => { if (e.target.value) setModel(e.target.value); }}><option value="">已获取 {models.length} 个模型 · 选择填入</option>{models.map(m => <option key={m} value={m}>{m}</option>)}</select>}
              <datalist id="tiphys-model-options">{models.map(m => <option key={m} value={m} />)}</datalist>
              <small>{models.length ? "可从上方列表选择，也可手动输入模型 ID。" : "不确定模型 ID 时，先填好地址和密钥，再点「拉取模型」。"}</small>
            </div>
            <label className="settings-field"><span>API Key</span><div className="settings-secret"><input aria-label="API Key" autoComplete="off" type={showKey ? "text" : "password"} value={key} onChange={e => setKey(e.target.value)} placeholder={settings?.hasApiKey ? "已保存凭据，留空保留" : "输入 API Key"} /><button type="button" className="plain-icon" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey(v => !v)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><small>留空保留现有密钥；输入新值会替换。支持用空格分隔多个密钥。</small></label>
            {!!settings?.environmentOverrides.length && <p className="settings-warning">启动环境覆盖：{settings.environmentOverrides.join("、")}。调整启动配置后，才能在这里保存。</p>}
          </>}
          {tab === "appearance" && <>
            <div className="settings-section-heading"><h2>外观</h2><p>外观选项即时生效，并自动保存在本机。</p></div>
            <h3>主题</h3><div className="theme-choices">{([{ id: "light", label: "浅色", icon: Sun }, { id: "dark", label: "深色", icon: Moon }, { id: "system", label: "跟随系统", icon: Monitor }] as const).map(t => <button key={t.id} type="button" className={`theme-choice theme-${t.id}`} aria-pressed={theme === t.id} onClick={() => onTheme(t.id)}><t.icon size={21} /><span>{t.label}</span>{theme === t.id && <Check size={15} />}</button>)}</div>
            <label className="settings-field"><span>界面密度</span><select aria-label="界面密度" value={density} onChange={e => onDensity(e.target.value as "standard" | "compact")}><option value="standard">标准</option><option value="compact">紧凑</option></select><small>紧凑模式缩小内容列表行距，便于同时查看更多图层。</small></label>
            <div className="settings-static"><span>界面语言</span><strong>简体中文</strong></div>
          </>}
          {tab === "runtime" && <>
            <div className="settings-section-heading"><h2>运行参数</h2><p>按所使用模型的能力设置，保存时与 API 配置一起生效。</p></div>
            <label className="settings-field"><span>模型上下文窗口（tokens）</span><input type="number" aria-label="模型上下文窗口" min="8000" max="2000000" value={contextWindow} onChange={e => setContextWindow(Number(e.target.value))} /><small>用于判断何时整理对话上下文，不限制模型思考时长。</small></label>
            <label className="settings-field"><span>单次工具输出上限（字符）</span><input type="number" aria-label="工具输出上限" min="1000" max="100000" value={maxOutput} onChange={e => setMaxOutput(Number(e.target.value))} /><small>超出部分保留为可读取记录，避免大表占满对话上下文。</small></label>
            <h3>工作区记忆</h3>
            <div className="settings-static"><span>项目记忆</span><strong>.tiphys/MEMORY.md</strong></div>
            <p className="settings-help">每轮对话会注入项目记忆。桌面版同时读取 <code>~/.tiphys/memory.md</code>；浏览器版读取构建时内置的项目记忆。请勿在记忆文件中保存密钥。</p>
          </>}
          {tab === "about" && <>
            <div className="settings-section-heading"><h2>TIPHYS</h2><p>Agent 驱动的地理空间工作区 · 0.1.0</p></div>
            <div className="settings-static"><span>数据处理</span><strong>本地空间引擎</strong></div>
            <label className="settings-field"><span>配置文件位置</span><input readOnly aria-label="配置文件位置" value={settings?.configPath ?? "读取中…"} /></label>
            <div className="settings-static"><span>配置备份</span><strong title={settings?.backupPath}>{settings?.backupPath ?? "—"}</strong></div>
            <p className="settings-help">保存 API 配置时会自动在用户目录留一份备份；更新、重装或清理应用数据后，配置会自动恢复。密钥只存在本机。</p>
            <p className="settings-help">遇到连接、工具或任务问题，可以在运行日志中查看详细记录与服务状态。</p>
            <button type="button" className="icon-btn" onClick={() => { onClose(); onLogs(); }}>打开运行日志</button>
          </>}
          {(error || message) && <div role={error ? "alert" : "status"} className={error ? "settings-feedback error" : "settings-feedback success"}>{error || message}</div>}
        </div>
      </div>
      <footer className="settings-footer"><span>{tab === "appearance" ? "外观已自动保存" : "密钥仅保存在本机配置中，不会返回给界面。"}</span><div>
        {(tab === "api" || tab === "runtime") && <><button type="button" className="icon-btn" disabled={!!pending || !settings} onClick={() => void submit(true)}>{pending === "test" ? <LoaderCircle className="spin" size={15} /> : <PlugZap size={15} />}测试连接</button><button type="button" className="primary-btn" disabled={!!pending || !settings} onClick={() => void submit(false)}>{pending === "save" ? "保存中…" : "保存并应用"}</button></>}
        {tab !== "api" && tab !== "runtime" && <button type="button" className="primary-btn" onClick={onClose}>完成</button>}
      </div></footer>
    </div>
  </div>;
}
