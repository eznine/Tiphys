import { FormEvent } from "react";
import { ArrowUp, Plus, Square } from "lucide-react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  connected: boolean;
  unconfigured: boolean;
  onSend: (text: string) => Promise<boolean>;
  onCancelTurn: () => void;
  onActions: () => void;
  placeholder?: string;
};

/** Slim chat composer for the mobile layout: "+" opens the action sheet,
 *  the send button becomes stop while the agent is working. */
export function MobileComposer({ value, onChange, busy, connected, unconfigured, onSend, onCancelTurn, onActions, placeholder }: Props) {
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text || busy || !connected || unconfigured) return;
    // Dismiss IME after send (bottom-card send pointerdown prevents pre-click blur).
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (await onSend(text)) onChange("");
  };
  return (
    <form className="mobile-composer" onSubmit={submit}>
      <button type="button" className="mobile-composer-add" aria-label="更多操作" title="添加数据、图层、工具箱等" onClick={onActions}><Plus size={21} strokeWidth={2} /></button>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder ?? "描述你的目标…"} aria-label="对话消息" enterKeyHint="send" autoComplete="off"
        onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      {busy
        ? <button type="button" className="mobile-composer-send" aria-label="停止回复" onClick={onCancelTurn}><Square size={15} fill="currentColor" /></button>
        : <button type="submit" className="mobile-composer-send" aria-label="发送消息" disabled={!value.trim() || !connected || unconfigured}><ArrowUp size={20} strokeWidth={2.4} /></button>}
    </form>
  );
}
