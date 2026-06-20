//! Unlock-session state machine with an idle TTL. Clock is injected for testing.

use std::time::{Duration, Instant};

pub struct SessionState {
    ttl: Duration,
    /// Some(last_activity) when unlocked, None when locked.
    unlocked_since_activity: Option<Instant>,
}

impl SessionState {
    pub fn new(ttl: Duration) -> Self {
        SessionState {
            ttl,
            unlocked_since_activity: None,
        }
    }

    /// Unlock the session. Re-unlocking while already unlocked resets the idle TTL (intended).
    pub fn unlock(&mut self, now: Instant) {
        self.unlocked_since_activity = Some(now);
    }

    pub fn lock(&mut self) {
        self.unlocked_since_activity = None;
    }

    /// Record activity, resetting the idle timer (no-op if already locked/expired).
    pub fn touch(&mut self, now: Instant) {
        if self.is_unlocked(now) {
            self.unlocked_since_activity = Some(now);
        }
    }

    pub fn is_unlocked(&self, now: Instant) -> bool {
        match self.unlocked_since_activity {
            Some(last) => now.duration_since(last) <= self.ttl,
            None => false,
        }
    }

    pub fn expires_in_seconds(&self, now: Instant) -> Option<u64> {
        match self.unlocked_since_activity {
            Some(last) => {
                let elapsed = now.duration_since(last);
                if elapsed <= self.ttl {
                    Some((self.ttl - elapsed).as_secs())
                } else {
                    None
                }
            }
            None => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_by_default() {
        let s = SessionState::new(Duration::from_secs(300));
        let now = Instant::now();
        assert!(!s.is_unlocked(now));
        assert_eq!(s.expires_in_seconds(now), None);
    }

    #[test]
    fn unlocked_then_expires_after_ttl() {
        let mut s = SessionState::new(Duration::from_secs(300));
        let t0 = Instant::now();
        s.unlock(t0);
        assert!(s.is_unlocked(t0));
        assert_eq!(s.expires_in_seconds(t0), Some(300));

        let t_mid = t0 + Duration::from_secs(100);
        assert!(s.is_unlocked(t_mid));
        assert_eq!(s.expires_in_seconds(t_mid), Some(200));

        let t_after = t0 + Duration::from_secs(301);
        assert!(!s.is_unlocked(t_after));
        assert_eq!(s.expires_in_seconds(t_after), None);
    }

    #[test]
    fn touch_extends_the_window() {
        let mut s = SessionState::new(Duration::from_secs(300));
        let t0 = Instant::now();
        s.unlock(t0);
        let t_use = t0 + Duration::from_secs(200);
        s.touch(t_use);
        // 250s after t0 is only 50s after the touch, still unlocked.
        assert!(s.is_unlocked(t0 + Duration::from_secs(250)));
    }

    #[test]
    fn explicit_lock_locks() {
        let mut s = SessionState::new(Duration::from_secs(300));
        let t0 = Instant::now();
        s.unlock(t0);
        s.lock();
        assert!(!s.is_unlocked(t0));
    }
}
