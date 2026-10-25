import type { ReactNode } from "react";

type Props = {
  projectName: string;
  onProject: () => void;
  /** Circular glass action on the left of the capsule. */
  left?: ReactNode;
  /** Circular glass action on the right of the capsule. */
  right?: ReactNode;
  /** Optional engine/status dot inside the capsule. */
  status?: "ok" | "error" | "pending" | "warn";
  className?: string;
};

/**
 * Shared liquid-glass project capsule used on map + chat top chrome.
 * Transparent row — chat bubbles / map show through; no solid header bar.
 */
export function MobileTopCapsule({ projectName, onProject, left, right, status, className }: Props) {
  return (
    <div className={"m-top-chrome" + (className ? ` ${className}` : "")} role="banner">
      <div className="m-top-chrome-side m-top-chrome-left">{left}</div>
      <button
        type="button"
        className="m-top-capsule"
        onClick={onProject}
        aria-label={`当前工程 ${projectName}，打开工程页`}
      >
        {status && <span className="m-status-dot" data-state={status} aria-hidden="true" />}
        <span className="m-top-capsule-name">{projectName}</span>
      </button>
      <div className="m-top-chrome-side m-top-chrome-right">{right}</div>
    </div>
  );
}
