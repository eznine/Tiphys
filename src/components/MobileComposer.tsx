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
  onActions: () => void;
  placeholder?: string;
  /** Clear bottom-card input-only mode after send/stop/idle (injected by MobileBottomCard). */
  onComposerIdle?: () => void;
};

/** Slim chat composer for the mobile layout: "+" opens the action sheet,
 *  the send button becomes stop while the agent is working. */
export function MobileComposer({
  value,
  onChange,
  busy,
  connected,
  unconfigured,
  onSend,
  onCancelTurn,
  onActions,
  placeholder,
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
    if (!text || busy || !connected || unconfigured) {
      onComposerIdle?.();
      inputRef.current?.blur();
      return;
    }
    sendingRef.current = true;
    try {
      onComposerIdle?.();
      inputRef.current?.blur();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (await onSend(text)) onChange("");
    } finally {
      sendingRef.current = false;
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await sendNow();
  };

  // Direct send on pointerdown — avoids preventDefault+requestSubmit race that
  // no-ops the first tap on OPPO while only restoring the dock.
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

  return (
    <form className="mobile-composer" onSubmit={submit}>
      <button
        type="button"
        className="mobile-composer-add"
        aria-label="更多操作"
        title="添加数据、图层、工具箱等"
        onPointerDown={onAddPointerDown}
        onClick={onActions}
      >
        <Plus size={21} strokeWidth={2} />
      </button>
      <input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? "描述你的目标…"}
        aria-label="对话消息"
        enterKeyHint="send"
        autoComplete="off"
        onKeyDown={e => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void sendNow();
          }
        }}
      />
      {busy
        ? (
          <button
            type="button"
            className="mobile-composer-send"
            aria-label="停止回复"
            onPointerDown={onStopPointerDown}
            onClick={onCancelTurn}
          >
            <Square size={15} fill="currentColor" />
          </button>
        )
        : (
          <button
            type="button"
            className="mobile-composer-send"
            aria-label="发送消息"
            disabled={!value.trim() || !connected || unconfigured}
            onPointerDown={onSendPointerDown}
          >
            <ArrowUp size={20} strokeWidth={2.4} />
          </button>
        )}
    </form>
  );
}
