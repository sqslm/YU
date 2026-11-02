use serde_json::Value;

pub const MAX_VALUE_UNITS: usize = 4000;

pub struct Foreground {
    pub handle: String,
    pub pid: u32,
    pub title: String,
}

pub fn matches_target(target: &Value, current: Option<&Foreground>) -> bool {
    let Some(current) = current else { return false };
    target["processId"]
        .as_u64()
        .is_some_and(|pid| pid != 0 && pid == current.pid as u64)
        && target["windowHandle"]
            .as_str()
            .filter(|s| !s.is_empty())
            .is_none_or(|handle| handle == current.handle)
        && target["windowTitle"].as_str() == Some(current.title.as_str())
}

// Match JavaScript's UTF-16 limit, keeping the tail without splitting an emoji.
pub fn clip_tail(units: &[u16]) -> (String, bool) {
    let mut start = units.len().saturating_sub(MAX_VALUE_UNITS);
    if start > 0
        && (0xdc00..=0xdfff).contains(&units[start])
        && (0xd800..=0xdbff).contains(&units[start - 1])
    {
        start += 1;
    }
    (
        String::from_utf16_lossy(&units[start..]),
        units.len() > MAX_VALUE_UNITS,
    )
}

/** Never expose the newly focused window after a slow provider returns. */
pub fn read_guarded(
    target: Option<&Value>,
    read: impl FnOnce() -> Option<Value>,
    mut foreground: impl FnMut() -> Option<Foreground>,
) -> Option<Value> {
    if target.is_some_and(|t| !matches_target(t, foreground().as_ref())) {
        return None;
    }
    let snapshot = read();
    if target.is_some_and(|t| !matches_target(t, foreground().as_ref())) {
        return None;
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    fn original() -> Option<Foreground> {
        Some(Foreground {
            handle: "11".into(),
            pid: 22,
            title: "Editor".into(),
        })
    }
    fn other() -> Option<Foreground> {
        Some(Foreground {
            handle: "33".into(),
            pid: 44,
            title: "Other".into(),
        })
    }

    #[test]
    fn clips_chinese_by_utf16_units_and_retains_the_tail() {
        let value = format!("前缀{}", "中".repeat(4000));
        let (tail, truncated) = clip_tail(&value.encode_utf16().collect::<Vec<_>>());
        assert!(truncated);
        assert_eq!(tail, "中".repeat(4000));
    }

    #[test]
    fn leaves_short_empty_and_exact_limit_values_intact() {
        for value in ["".into(), "中文 😀".into(), "a".repeat(4000)] {
            assert_eq!(
                clip_tail(&value.encode_utf16().collect::<Vec<_>>()),
                (value, false)
            );
        }
    }

    #[test]
    fn clipping_never_leaves_half_a_surrogate_pair() {
        let value = format!("😀{}", "a".repeat(3999));
        assert_eq!(
            clip_tail(&value.encode_utf16().collect::<Vec<_>>()),
            ("a".repeat(3999), true)
        );
        let value = format!("前{}", "😀".repeat(2000));
        assert_eq!(
            clip_tail(&value.encode_utf16().collect::<Vec<_>>()),
            ("😀".repeat(2000), true)
        );
    }

    #[test]
    fn target_requires_process_title_and_optional_decimal_handle() {
        let target = json!({"processId":22,"windowHandle":"11","windowTitle":"Editor"});
        assert!(matches_target(&target, original().as_ref()));
        assert!(!matches_target(&target, other().as_ref()));
        assert!(!matches_target(&target, None));
        for invalid in [
            json!({}),
            json!({"processId":0,"windowTitle":"Editor"}),
            json!({"processId":22,"windowTitle":"Other"}),
            json!({"processId":22,"windowTitle":"Editor","windowHandle":"0xb"}),
        ] {
            assert!(!matches_target(&invalid, original().as_ref()));
        }
        assert!(matches_target(
            &json!({"processId":22,"windowTitle":"Editor"}),
            original().as_ref()
        ));
    }

    #[test]
    fn mismatched_window_is_rejected_before_reading_any_text() {
        let calls = Cell::new(0);
        let snapshot = read_guarded(
            Some(&json!({"processId":22,"windowTitle":"Editor"})),
            || {
                calls.set(calls.get() + 1);
                Some(json!({"value":"original"}))
            },
            other,
        );
        assert!(snapshot.is_none());
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn window_change_after_provider_returns_discards_snapshot() {
        let mut calls = 0;
        let snapshot = read_guarded(
            Some(&json!({"processId":22,"windowTitle":"Editor"})),
            || Some(json!({"value":"original"})),
            || {
                calls += 1;
                if calls == 1 { original() } else { other() }
            },
        );
        assert!(snapshot.is_none());
        assert_eq!(calls, 2);
    }

    #[test]
    fn unchanged_target_keeps_the_snapshot_and_missing_target_does_not_probe_foreground() {
        let expected = Some(json!({"value":"original"}));
        assert_eq!(
            read_guarded(
                Some(&json!({"processId":22,"windowTitle":"Editor"})),
                || expected.clone(),
                original
            ),
            expected
        );
        assert_eq!(
            read_guarded(
                None,
                || expected.clone(),
                || panic!("unrequested foreground read")
            ),
            expected
        );
    }
}
