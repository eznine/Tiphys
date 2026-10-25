import { FormEvent, PointerEvent, useRef } from "react";
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
  /** Clear bottom-card input-only mode after send/stop/idle (injected by MobileBottomCard). */
  onComposerIdle?: () => void;
};

/** AI bar embedded in the map's bottom card. It really sends to the Agent. */
export function MobileMapAskBar({
  value,
  onChange,
  busy,
  connected,
  unconfigured,
  onSend,
  onCancelTurn,
  onOpenActions,
  onComposerIdle,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  const canSend = () => {
    const text = (inputRef.current?.value ?? value).trim();
    return !!text && !busy && connected && !unconfigured;
  };

  const sendNow = async () => {
    if (sendingRef.current) return;
    const text = (inputRef.current?.value ?? value).trim();
    if (!text || busy) {
      onComposerIdle?.();
      inputRef.current?.blur();
      return;
    }
    sendingRef.current = true;
    try {
      onComposerIdle?.();
      inputRef.current?.blur();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const ok = await onSend(text);
      if (ok) onChange("");
    } finally {
      sendingRef.current = false;
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await sendNow();
  };

  const onSendPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button != null && event.button !== 0) return;
    if (!canSend()) {
      onComposerIdle?.();
      inputRef.current?.blur();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void sendNow();
  };

  const onStopPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onComposerIdle?.();
    inputRef.current?.blur();
    onCancelTurn();
  };

  const onAddPointerDown = () => {
    onComposerIdle?.();
  };

  return <form className="m-askbar" onSubmit={submit}>
    <button
      type="button"
      className="m-askbar-add"
      aria-label="更多操作"
      onPointerDown={onAddPointerDown}
      onClick={onOpenActions}
    >
      <Plus size={20} />
    </button>
    <input
      ref={inputRef}
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder="描述你的空间分析目标"
      aria-label="向 Agent 描述任务"
      enterKeyHint="send"
      autoComplete="off"
      onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void sendNow();
        }
      }}
    />
    {busy
      ? (
        <button
          type="button"
          className="m-askbar-send"
          aria-label="停止回复"
          onPointerDown={onStopPointerDown}
          onClick={onCancelTurn}
        >
          <Square size={14} fill="currentColor" />
        </button>
      )
      : (
        <button
          type="button"
          className="m-askbar-send"
          aria-label="发送"
          disabled={!value.trim() || !connected || unconfigured}
          onPointerDown={onSendPointerDown}
        >
          <ArrowUp size={20} strokeWidth={2.4} />
        </button>
      )}
  </form>;
}
