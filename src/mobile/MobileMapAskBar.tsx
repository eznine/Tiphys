import { ArrowUp, Plus, Square } from "lucide-react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  connected: boolean;
  unconfigured: boolean;
  onSend: (text: string) => Promise<boolean>;
  onCancelTurn: () => void;
  onOpenActions: () => void;
};

/** AI bar embedded in the map's bottom card. It really sends to the Agent. */
export function MobileMapAskBar({ value, onChange, busy, connected, unconfigured, onSend, onCancelTurn, onOpenActions }: Props) {
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    const ok = await onSend(text);
    if (ok) onChange("");
  };
  return <form className="m-askbar" onSubmit={submit}>
    <button type="button" className="m-askbar-add" aria-label="更多操作" onClick={onOpenActions}><Plus size={20} /></button>
    <input value={value} onChange={event => onChange(event.target.value)} placeholder="描述目标，例如：为学校生成 1 公里服务圈"
      aria-label="向 Agent 描述任务" enterKeyHint="send" autoComplete="off"
      onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
    {busy
      ? <button type="button" className="m-askbar-send" aria-label="停止回复" onClick={onCancelTurn}><Square size={14} fill="currentColor" /></button>
      : <button type="submit" className="m-askbar-send" aria-label="发送" disabled={!value.trim() || !connected || unconfigured}><ArrowUp size={20} strokeWidth={2.4} /></button>}
  </form>;
}
