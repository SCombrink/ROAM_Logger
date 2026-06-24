import { useEffect, useRef, useState } from "react";
import type { WarmupOverlayProps } from "./types";

// Rotating loading messages. Cycled through one every 2.5 seconds.
// 12 entries means we cycle every 30 seconds; the warmup itself should be done
// within 30-60 seconds so users will see most messages but only loop a few.
const LOADING_MESSAGES = [
  "Configuring the app...",
  "Setting things up...",
  "Aligning your data...",
  "Calibrating the connection...",
  "Polishing the edges...",
  "Warming up the engine...",
  "Loading projects from Hatch...",
  "Synchronising preferences...",
  "Smoothing things over...",
  "Tuning the workflow...",
  "Almost there...",
  "Just a moment...",
];

const MESSAGE_INTERVAL_MS = 2500;

export function WarmupOverlay(props: WarmupOverlayProps) {
  const {
    state,
    attempt,
    maxAttempts,
    networkRetrySeconds,
    onRetry,
    isDark,
    renderQuestionMenu,
  } = props;

  // Self-rotating message index. Only ticks while in loading state.
  const [messageIndex, setMessageIndex] = useState(0);
  const [questionMenuOpen, setQuestionMenuOpen] = useState(false);

  useEffect(() => {
    if (state !== "loading") return;
    const id = window.setInterval(() => {
      setMessageIndex(i => (i + 1) % LOADING_MESSAGES.length);
    }, MESSAGE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [state]);

  // Close the question menu when user clicks outside it
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!questionMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setQuestionMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [questionMenuOpen]);

  // Hatch colour palette - mirrors App.tsx for visual consistency
  const colors = isDark
    ? {
        bg: "#1A1A1A",
        surface: "#2A2A2A",
        text: "#E0E0E0",
        textMuted: "#A0A0A0",
        primary: "#5B7A8C",
        green: "#1A7F37",
        orange: "#E84A37",
        border: "#4A4A4A",
        cardBg: "#242424",
      }
    : {
        bg: "#FAFAFA",
        surface: "#F0F0F0",
        text: "#2E2E2E",
        textMuted: "#595959",
        primary: "#425563",
        green: "#1A7F37",
        orange: "#E84A37",
        border: "#BFBFBF",
        cardBg: "#FFFFFF",
      };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        backgroundColor: colors.bg,
        color: colors.text,
        fontFamily: "'Source Sans Pro', Arial, sans-serif",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
      }}
    >
      <style>{`
        @keyframes warmup-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes warmup-fade-in {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes warmup-pop-in {
          0% { transform: scale(0.6); opacity: 0; }
          70% { transform: scale(1.1); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .warmup-spinner {
          width: 72px;
          height: 72px;
          border: 6px solid ${colors.surface};
          border-top-color: ${colors.primary};
          border-radius: 50%;
          animation: warmup-spin 1.2s linear infinite;
        }
        .warmup-message {
          animation: warmup-fade-in 0.4s ease-out;
        }
        .warmup-icon {
          animation: warmup-pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
      `}</style>

      {/* `?` button in top-right corner */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 16,
        }}
        ref={menuRef}
      >
        <button
          onClick={() => setQuestionMenuOpen(o => !o)}
          title="App info"
          style={{
            padding: 0,
            border: `1px solid ${colors.border}`,
            borderRadius: "50%",
            backgroundColor: colors.surface,
            color: colors.text,
            fontWeight: "bold",
            fontSize: 12,
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          ?
        </button>
        {questionMenuOpen && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 4,
              padding: "8px 12px",
              backgroundColor: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              fontSize: 11,
              color: colors.textMuted,
              whiteSpace: "nowrap",
              zIndex: 100,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              alignItems: "flex-start",
            }}
          >
            {renderQuestionMenu()}
          </div>
        )}
      </div>

      {/* Centered content area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px",
          textAlign: "center",
        }}
      >
        {state === "loading" && (
          <>
            <div className="warmup-spinner" />
            <div
              key={messageIndex}
              className="warmup-message"
              style={{
                marginTop: 32,
                fontSize: 16,
                fontWeight: 500,
                color: colors.text,
                minHeight: 22,
              }}
            >
              {LOADING_MESSAGES[messageIndex]}
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 12,
                color: colors.textMuted,
                maxWidth: 320,
                lineHeight: 1.5,
              }}
            >
              This may take up to a minute. Please don't close the app.
            </div>
            {/* Attempt counter only from attempt 2 onwards */}
            {attempt >= 2 && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: colors.textMuted,
                  fontStyle: "italic",
                }}
              >
                Attempt {attempt} of {maxAttempts}
              </div>
            )}
          </>
        )}

        {state === "network_error" && (
          <>
            <div
              className="warmup-icon"
              style={{
                fontSize: 56,
                color: colors.orange,
                marginBottom: 24,
              }}
              aria-hidden
            >
              ⚠
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: colors.text,
                marginBottom: 12,
              }}
            >
              Server offline, check network connection
            </div>
            <div
              style={{
                fontSize: 12,
                color: colors.textMuted,
                marginBottom: 24,
                maxWidth: 360,
                lineHeight: 1.5,
              }}
            >
              ROAM Logger could not reach the Hatch ROAM server. Make sure you
              are connected to the Hatch network or VPN.
            </div>
            {networkRetrySeconds !== null && networkRetrySeconds > 0 && (
              <div
                style={{
                  fontSize: 11,
                  color: colors.textMuted,
                  marginBottom: 16,
                }}
              >
                Checking again in {networkRetrySeconds} seconds...
              </div>
            )}
            <button
              onClick={onRetry}
              style={{
                padding: "8px 18px",
                border: `1px solid ${colors.primary}`,
                borderRadius: 4,
                backgroundColor: colors.primary,
                color: "#FFFFFF",
                fontWeight: 600,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Retry now
            </button>
          </>
        )}

        {state === "success" && (
          <>
            <div
              className="warmup-icon"
              style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                backgroundColor: colors.green,
                color: "#FFFFFF",
                fontSize: 44,
                fontWeight: "bold",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}
              aria-hidden
            >
              ✓
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: colors.text,
              }}
            >
              Setup complete
            </div>
          </>
        )}

        {state === "failure" && (
          <>
            <div
              className="warmup-icon"
              style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                backgroundColor: colors.orange,
                color: "#FFFFFF",
                fontSize: 38,
                fontWeight: "bold",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}
              aria-hidden
            >
              ✕
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: colors.text,
                marginBottom: 12,
              }}
            >
              Setup failed
            </div>
            <div
              style={{
                fontSize: 12,
                color: colors.textMuted,
                marginBottom: 24,
                maxWidth: 360,
                lineHeight: 1.5,
              }}
            >
              ROAM Logger could not complete first-time setup. Click Retry to
              try again, or use the <strong>?</strong> menu to send feedback.
            </div>
            <button
              onClick={onRetry}
              style={{
                padding: "8px 18px",
                border: `1px solid ${colors.primary}`,
                borderRadius: 4,
                backgroundColor: colors.primary,
                color: "#FFFFFF",
                fontWeight: 600,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}