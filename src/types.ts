// Shared types between App.tsx and WarmupOverlay.tsx
export type WarmupState =
  | "loading"
  | "network_error"
  | "success"
  | "failure";

export interface WarmupOverlayProps {
  /** Current state of the warmup process */
  state: WarmupState;
  /** Current attempt number (1, 2, or 3). Only shown from attempt 2 onwards. */
  attempt: number;
  /** Maximum attempts. Used in "Attempt X of Y" text. */
  maxAttempts: number;
  /** Seconds remaining before next network re-check (only used in network_error state) */
  networkRetrySeconds: number | null;
  /** Called when the user clicks "Retry now" on the network_error or failure state */
  onRetry: () => void;
  /** Whether dark mode is active */
  isDark: boolean;
  /**
   * Render prop for the `?` button dropdown content. App.tsx passes its existing
   * dropdown markup so the overlay's escape hatch behaves identically to the
   * main app's `?` button (Send Feedback, Install Update, etc.).
   */
  renderQuestionMenu: () => React.ReactNode;
}