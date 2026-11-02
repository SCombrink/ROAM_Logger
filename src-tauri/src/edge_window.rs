// Where and how big the app's visible Edge windows are, and when a sign-in
// page may open one. Free of Edge and Tauri so it can be unit-tested.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The page size ROAM is laid out at in the small window, and how much it is
/// shrunk to fit.
pub(crate) const SMALL_PAGE: (u32, u32) = (1280, 1100);
pub(crate) const SMALL_SCALE: f64 = 0.5;

/// The main screen's size in device-independent pixels, noted at startup,
/// to place the small window in its bottom-right corner.
static SCREEN_SIZE: std::sync::OnceLock<(i32, i32)> = std::sync::OnceLock::new();

pub(crate) fn set_screen_size(size: (i32, i32)) {
    let _ = SCREEN_SIZE.set(size);
}

/// Edge arguments for a small window in the bottom-right corner of the main
/// screen (top-left if the screen size is unknown), sized for a page of
/// `page` pixels shrunk by `scale` (see fit_page).
pub(crate) fn small_window_args(page: (u32, u32), scale: f64) -> Vec<String> {
    let (w, h) = ((page.0 as f64 * scale) as i32 + 16, (page.1 as f64 * scale) as i32 + 90);
    let (x, y) = SCREEN_SIZE.get().map(|(sw, sh)| ((sw - w - 24).max(0), (sh - h - 64).max(0))).unwrap_or((40, 40));
    vec![format!("--window-size={},{}", w, h), format!("--window-position={},{}", x, y)]
}

/// True for a Microsoft (or company ADFS/Okta) sign-in page.
pub(crate) fn is_sign_in_url(url: &str) -> bool {
    let u = url.to_lowercase();
    ["login.microsoftonline.com", "login.microsoft.com", "login.live.com", "login.windows.net", "/adfs/", "okta.com"]
        .iter()
        .any(|p| u.contains(p))
}

/// Microsoft sign-in often shows its page for a moment and then completes by
/// itself (Windows account, saved cookies). Only a page that stays on sign-in
/// this long in a hidden window means the user has to sign in...
pub(crate) const HIDDEN_SIGN_IN_GRACE: Duration = Duration::from_secs(8);
/// ...and only after this long in a visible window is the user asked to.
pub(crate) const PROMPT_SIGN_IN_GRACE: Duration = Duration::from_secs(3);

/// How long a page has stayed on a sign-in page without a break.
#[derive(Default)]
pub(crate) struct SignInWatch {
    since: Option<Instant>,
}

impl SignInWatch {
    /// Records whether the page is on a sign-in page now; returns how long
    /// it has been there (zero when it isn't).
    pub(crate) fn held(&mut self, on_sign_in: bool) -> Duration {
        if on_sign_in {
            self.since.get_or_insert_with(Instant::now).elapsed()
        } else {
            self.since = None;
            Duration::ZERO
        }
    }
}

/// Background checks may open a sign-in window once per launch; anything
/// the user started may always. Signing in once usually fixes the rest too,
/// as every check uses the same Edge profile.
static BACKGROUND_SIGN_IN_SHOWN: AtomicBool = AtomicBool::new(false);

pub(crate) fn may_show_sign_in(interactive: bool) -> bool {
    interactive || !BACKGROUND_SIGN_IN_SHOWN.swap(true, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_pages() {
        assert!(is_sign_in_url("https://login.microsoftonline.com/abc/oauth2/authorize?client_id=x"));
        assert!(is_sign_in_url("https://LOGIN.MICROSOFTONLINE.COM/common/login"));
        assert!(is_sign_in_url("https://sts.hatch.com/adfs/ls/?wa=wsignin1.0"));
        assert!(!is_sign_in_url("https://app.powerbi.com/groups/me/reports/9444"));
        assert!(!is_sign_in_url("https://hatchengineering-my.sharepoint.com/personal/x/_layouts/15/onedrive.aspx"));
        assert!(!is_sign_in_url("https://roam.example.com/NetForms/Observation"));
    }

    #[test]
    fn sign_in_must_stay_to_count() {
        let mut w = SignInWatch::default();
        assert_eq!(w.held(false), Duration::ZERO);
        w.held(true);
        std::thread::sleep(Duration::from_millis(30));
        assert!(w.held(true) >= Duration::from_millis(30));
        // A redirect away (sign-in completed by itself) starts over.
        assert_eq!(w.held(false), Duration::ZERO);
        assert!(w.held(true) < Duration::from_millis(30));
        assert!(HIDDEN_SIGN_IN_GRACE > PROMPT_SIGN_IN_GRACE);
    }

    #[test]
    fn background_sign_in_once_per_launch() {
        assert!(may_show_sign_in(true));
        assert!(may_show_sign_in(false));
        assert!(!may_show_sign_in(false));
        assert!(may_show_sign_in(true));
    }

    #[test]
    fn small_window_in_the_corner() {
        // Unknown screen: top-left.
        assert_eq!(small_window_args(SMALL_PAGE, SMALL_SCALE), vec!["--window-size=656,640", "--window-position=40,40"]);
        set_screen_size((1920, 1080));
        assert_eq!(small_window_args(SMALL_PAGE, SMALL_SCALE), vec!["--window-size=656,640", "--window-position=1240,376"]);
        // The Power BI sign-in window: report at 1600x1200, shrunk to 40%.
        assert_eq!(small_window_args((1600, 1200), 0.4), vec!["--window-size=656,570", "--window-position=1240,446"]);
    }
}
