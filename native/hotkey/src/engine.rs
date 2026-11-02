use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
struct Binding {
    mode: String,
    keys: Vec<u32>,
    primary: u32,
    reminder: bool,
}

impl Binding {
    fn from(mode: &str, values: &Value) -> Result<Option<Self>, String> {
        let Some(values) = values.as_array() else {
            return Ok(None);
        };
        let keys: Vec<u32> = values
            .iter()
            .map(|v| token_to_vk(v.as_str().unwrap_or("")))
            .collect::<Result<_, _>>()?;
        Ok(keys.first().copied().map(|primary| Self {
            mode: mode.into(),
            keys,
            primary,
            reminder: false,
        }))
    }

    fn last(&self) -> u32 {
        *self.keys.last().unwrap_or(&self.primary)
    }
}

#[derive(Default)]
struct Press {
    at: u64,
    eaten: bool,
    os_saw_down: bool,
    os_up_since: Option<u64>,
}

pub struct Engine {
    enabled: bool,
    capturing: bool,
    capture_held: BTreeSet<u32>,
    pressed: BTreeMap<u32, Press>,
    bindings: Vec<Binding>,
    actions: Vec<(&'static str, Binding)>,
    notes: Option<Binding>,
    recording: Option<Binding>,
    pending: Option<(Binding, Option<Binding>)>,
    action_pending: Option<(String, Vec<u32>)>,
    hold: bool,
    card: bool,
    activity: String,
    pub events: Vec<Value>,
    pub releases: Vec<u32>,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            enabled: true,
            capturing: false,
            capture_held: BTreeSet::new(),
            pressed: BTreeMap::new(),
            bindings: vec![],
            actions: vec![],
            notes: None,
            recording: None,
            pending: None,
            action_pending: None,
            hold: false,
            card: false,
            activity: "idle".into(),
            events: vec![],
            releases: vec![],
        }
    }
}

impl Engine {
    pub fn pressed_keys(&self) -> Vec<u32> {
        self.pressed.keys().copied().collect()
    }

    // No timer runs while idle. Reconciliation never determines a gesture's mode.
    pub fn wait_ms(&self) -> u32 {
        if self.pressed.is_empty() {
            u32::MAX
        } else {
            25
        }
    }

    pub fn command(&mut self, data: &Value, now: u64) -> Result<(), String> {
        match data["type"].as_str().unwrap_or("") {
            "config" => {
                let mut bindings = vec![];
                if let Some(values) = data["bindings"].as_object() {
                    for (mode, keys) in values {
                        if !["dictation", "translate", "ask"].contains(&mode.as_str()) {
                            return Err(format!("unknown mode: {mode}"));
                        }
                        if let Some(b) = Binding::from(mode, keys)? {
                            bindings.push(b);
                        }
                    }
                }
                if let Some(mut b) = Binding::from("dictation", &data["reminder"])? {
                    b.primary = b.last();
                    b.reminder = true;
                    bindings.push(b);
                }
                bindings.sort_by_key(|b| std::cmp::Reverse(b.keys.len()));
                let mut actions = vec![];
                for (field, event) in [
                    ("pasteLast", "paste-last"),
                    ("selection", "selection"),
                    ("selectionTranslate", "selection-translate"),
                    ("assistant", "assistant-toggle"),
                    ("screenshot", "screenshot"),
                    ("promptCycle", "prompt-cycle"),
                ] {
                    if let Some(b) = Binding::from("dictation", &data[field])? {
                        actions.push((event, b));
                    }
                }
                self.notes = Binding::from("dictation", &data["notes"])?;
                self.bindings = bindings;
                self.actions = actions;
                if let Some(value) = data["activation"].as_str() {
                    if !["toggle", "hold"].contains(&value) {
                        return Err(format!("unknown activation: {value}"));
                    }
                    self.hold = value == "hold";
                }
                self.pending = None;
                self.action_pending = None;
                self.pressed.clear();
            }
            "enabled" => {
                self.enabled = data["value"]
                    .as_bool()
                    .ok_or("enabled.value must be boolean")?;
                if !self.enabled {
                    if let Some(b) = self.recording.take() {
                        self.emit("stop", &b, now);
                    }
                    self.pending = None;
                    self.action_pending = None;
                    self.pressed.clear();
                }
            }
            "capture" => {
                self.capturing = data["active"]
                    .as_bool()
                    .ok_or("capture.active must be boolean")?;
                self.pending = None;
                self.action_pending = None;
            }
            "card" => self.card = data["open"].as_bool().ok_or("card.open must be boolean")?,
            "activity" => {
                let value = data["value"]
                    .as_str()
                    .ok_or("activity.value must be a string")?;
                if !["idle", "recording", "working"].contains(&value) {
                    return Err(format!("unknown activity: {value}"));
                }
                self.activity = value.into();
                if value != "recording" {
                    self.recording = None;
                }
            }
            "reset" => {
                self.recording = None;
                self.pending = None;
                self.action_pending = None;
                self.pressed.clear();
            }
            other => return Err(format!("unknown command: {other}")),
        }
        Ok(())
    }

    fn all_down(&self, keys: &[u32]) -> bool {
        !keys.is_empty() && keys.iter().all(|k| self.pressed.contains_key(k))
    }

    fn match_binding(&self) -> Option<Binding> {
        self.bindings
            .iter()
            .find(|b| {
                self.all_down(&b.keys)
                    && (!b.reminder || self.pressed.get(&b.primary).is_some_and(|p| p.eaten))
            })
            .cloned()
    }

    fn owned(&self) -> bool {
        self.recording.is_some()
            || self.pending.is_some()
            || self.action_pending.is_some()
            || self.card
            || self.activity != "idle"
    }

    fn swallow_down(&self, vk: u32) -> bool {
        if !self.enabled {
            return false;
        }
        if vk == 0x1b && self.owned() {
            return true;
        }
        if vk == 0xa5 && (self.recording.is_some() || self.activity == "recording") {
            return true;
        }
        if self
            .actions
            .iter()
            .any(|(_, b)| vk == b.last() && self.all_down(&b.keys))
        {
            return true;
        }
        if self
            .notes
            .as_ref()
            .is_some_and(|b| vk == b.last() && self.all_down(&b.keys))
        {
            return true;
        }
        self.bindings.iter().any(|b| {
            if b.reminder {
                vk == b.primary && self.all_down(&b.keys)
            } else {
                b.keys.contains(&vk) && (vk == b.primary || self.pressed.contains_key(&b.primary))
            }
        })
    }

    pub fn key(&mut self, vk: u32, down: bool, now: u64, desktop: impl Fn() -> bool) -> bool {
        if self.capturing || self.capture_held.contains(&vk) {
            let repeat = self.capture_held.contains(&vk);
            if down {
                self.capture_held.insert(vk);
            } else {
                self.capture_held.remove(&vk);
            }
            if self.capturing
                && (!down || !repeat)
                && let Some(token) = vk_to_token(vk)
            {
                self.events
                    .push(json!({"type":"capture-key", "token":token, "down":down}));
            }
            return true;
        }
        let mut repeat = down && self.pressed.contains_key(&vk);
        if repeat && now.saturating_sub(self.pressed[&vk].at) > 1200 {
            if self.pressed[&vk].eaten {
                self.releases.push(vk);
            }
            self.pressed.remove(&vk);
            repeat = false;
        }
        let existed = self.pressed.contains_key(&vk);
        let eaten = if down {
            self.pressed.entry(vk).or_default().at = now;
            let eaten = (repeat && self.pressed[&vk].eaten) || self.swallow_down(vk);
            self.pressed.get_mut(&vk).unwrap().eaten = eaten;
            eaten
        } else {
            self.pressed.remove(&vk).is_some_and(|p| p.eaten)
        };
        if !repeat
            && (vk == 0x1b
                || self.bindings.iter().any(|b| b.keys.contains(&vk))
                || self.actions.iter().any(|(_, b)| b.keys.contains(&vk))
                || self.notes.as_ref().is_some_and(|b| b.keys.contains(&vk)))
        {
            self.events.push(json!({"type":"log", "line":format!("[hook] {} 0x{vk:x}{}", if down {"down"} else {"up"}, if eaten {" eaten"} else {""})}));
        }
        self.drive(
            now,
            if down && !repeat { Some(vk) } else { None },
            if !down && existed { vec![vk] } else { vec![] },
            desktop,
        );
        eaten
    }

    pub fn reconcile(&mut self, now: u64, held: &BTreeSet<u32>, desktop: impl Fn() -> bool) {
        let mut dropped = vec![];
        for (&vk, press) in &mut self.pressed {
            if held.contains(&vk) {
                press.os_saw_down = true;
                press.os_up_since = None;
                continue;
            }
            if now.saturating_sub(press.at) < 150 {
                continue;
            }
            if press.eaten {
                if !press.os_saw_down {
                    continue;
                }
                let since = *press.os_up_since.get_or_insert(now);
                if now.saturating_sub(since) < 250 {
                    continue;
                }
                self.releases.push(vk);
            }
            dropped.push(vk);
        }
        if dropped.is_empty() {
            return;
        }
        for vk in &dropped {
            self.pressed.remove(vk);
        }
        self.events.push(json!({"type":"stale", "keys":dropped}));
        self.drive(now, None, dropped, desktop);
    }

    fn emit(&mut self, event: &str, binding: &Binding, now: u64) {
        let mut value = json!({"type":event, "mode":binding.mode, "at":now});
        if event == "start" && binding.reminder {
            value["purpose"] = "reminder".into();
        }
        self.events.push(value);
    }

    fn drive(
        &mut self,
        now: u64,
        entered: Option<u32>,
        left: Vec<u32>,
        desktop: impl Fn() -> bool,
    ) {
        if !self.enabled || self.capturing {
            return;
        }
        if self
            .action_pending
            .as_ref()
            .is_some_and(|(_, keys)| keys.iter().all(|k| !self.pressed.contains_key(k)))
        {
            let (event, _) = self.action_pending.take().unwrap();
            self.events.push(json!({"type":event, "at":now}));
        }
        for vk in left {
            if let Some(b) = &self.recording {
                if if self.hold {
                    b.keys.contains(&vk)
                } else {
                    !b.reminder && vk == b.primary
                } {
                    let b = self.recording.take().unwrap();
                    self.emit("stop", &b, now);
                }
                continue;
            }
            if self.pending.as_ref().is_some_and(|(b, _)| b.primary == vk) {
                let (original, chord) = self.pending.take().unwrap();
                if !desktop() {
                    continue;
                }
                let primary = original.primary;
                let mut b = chord.unwrap_or(original);
                b.primary = primary;
                self.emit("start", &b, now);
                self.recording = Some(b);
            }
        }
        let Some(vk) = entered else {
            return;
        };
        if vk == 0x1b {
            let owned = self.owned();
            self.action_pending = None;
            self.recording = None;
            self.pending = None;
            self.activity = "idle".into();
            if self.card {
                self.events.push(json!({"type":"esc", "at":now}));
            }
            if owned {
                self.events
                    .push(json!({"type":"cancel", "at":now, "reason":"esc"}));
            }
            return;
        }
        if vk == 0xa5 && (self.recording.is_some() || self.activity == "recording") {
            let mode = self
                .recording
                .take()
                .map(|b| b.mode)
                .unwrap_or("dictation".into());
            self.pending = None;
            self.activity = "working".into();
            self.events
                .push(json!({"type":"stop", "mode":mode, "at":now}));
            return;
        }
        if let Some(b) = &self.recording {
            let next = self.match_binding();
            if let Some(mut next) =
                next.filter(|next| !next.reminder && !b.reminder && next.keys.len() > b.keys.len())
            {
                next.primary = b.primary;
                self.emit("mode", &next, now);
                self.recording = Some(next);
            } else if vk == b.primary && (!b.reminder || self.all_down(&b.keys)) {
                let b = self.recording.take().unwrap();
                self.emit("stop", &b, now);
            }
            return;
        }
        if self.activity == "recording" {
            if self.notes.as_ref().is_some_and(|b| self.all_down(&b.keys)) {
                self.events.push(json!({"type":"notes-toggle", "at":now}));
            }
            return;
        }
        if let Some((b, _)) = &self.pending {
            if let Some(next) = self
                .match_binding()
                .filter(|next| !next.reminder && !b.reminder && next.keys.len() > b.keys.len())
            {
                self.pending.as_mut().unwrap().1 = Some(next);
            }
            return;
        }
        // Preserve action precedence: paste/selection, notes, then assistant/screenshot/prompt.
        for (event, b) in &self.actions {
            if !["paste-last", "selection", "selection-translate"].contains(event) {
                continue;
            }
            if vk == b.last() && self.all_down(&b.keys) {
                self.action_pending = Some(((*event).into(), b.keys.clone()));
                return;
            }
        }
        if self.notes.as_ref().is_some_and(|b| self.all_down(&b.keys)) {
            self.events.push(json!({"type":"notes-toggle", "at":now}));
            return;
        }
        for (event, b) in &self.actions {
            if ["paste-last", "selection", "selection-translate"].contains(event) {
                continue;
            }
            if vk == b.last() && self.all_down(&b.keys) {
                if *event == "prompt-cycle" {
                    self.events.push(json!({"type":event, "at":now}));
                } else {
                    self.action_pending = Some(((*event).into(), b.keys.clone()));
                }
                return;
            }
        }
        if let Some(b) = self.match_binding() {
            if self.hold {
                if desktop() {
                    self.emit("start", &b, now);
                    self.recording = Some(b);
                }
            } else {
                self.pending = Some((b, None));
            }
        }
    }
}

pub fn token_to_vk(token: &str) -> Result<u32, String> {
    if token.len() == 1
        && token.as_bytes()[0].is_ascii_alphanumeric()
        && !token.as_bytes()[0].is_ascii_lowercase()
    {
        return Ok(token.as_bytes()[0] as u32);
    }
    if let Some(number) = token
        .strip_prefix('F')
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| (1..=12).contains(n))
    {
        return Ok(0x6f + number);
    }
    match token {
        "LeftCtrl" => Ok(0xa2),
        "RightCtrl" => Ok(0xa3),
        "LeftAlt" => Ok(0xa4),
        "RightAlt" => Ok(0xa5),
        "LeftShift" => Ok(0xa0),
        "RightShift" => Ok(0xa1),
        "LeftWin" => Ok(0x5b),
        "RightWin" => Ok(0x5c),
        "Space" => Ok(0x20),
        "Tab" => Ok(9),
        "Enter" => Ok(13),
        "Escape" => Ok(0x1b),
        "Backspace" => Ok(8),
        "CapsLock" => Ok(0x14),
        "Insert" => Ok(0x2d),
        "Delete" => Ok(0x2e),
        "Home" => Ok(0x24),
        "End" => Ok(0x23),
        "PageUp" => Ok(0x21),
        "PageDown" => Ok(0x22),
        _ => Err(format!("unknown key token: {token}")),
    }
}

pub fn vk_to_token(vk: u32) -> Option<String> {
    for token in [
        "LeftCtrl",
        "RightCtrl",
        "LeftAlt",
        "RightAlt",
        "LeftShift",
        "RightShift",
        "LeftWin",
        "RightWin",
        "Space",
        "Tab",
        "Enter",
        "Escape",
        "Backspace",
        "CapsLock",
        "Insert",
        "Delete",
        "Home",
        "End",
        "PageUp",
        "PageDown",
    ] {
        if token_to_vk(token).ok() == Some(vk) {
            return Some(token.into());
        }
    }
    if (0x70..=0x7b).contains(&vk) {
        return Some(format!("F{}", vk - 0x6f));
    }
    if (0x30..=0x39).contains(&vk) || (0x41..=0x5a).contains(&vk) {
        return char::from_u32(vk).map(|c| c.to_string());
    }
    None
}

pub fn physical_vk(vk: u32, scan: u32, flags: u32) -> u32 {
    match vk {
        0x10 => {
            if scan == 0x36 {
                0xa1
            } else {
                0xa0
            }
        }
        0x11 => {
            if flags & 1 != 0 {
                0xa3
            } else {
                0xa2
            }
        }
        0x12 => {
            if flags & 1 != 0 {
                0xa5
            } else {
                0xa4
            }
        }
        _ => vk,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured(hold: bool) -> Engine {
        let mut engine = Engine::default();
        engine.command(&json!({"type":"config", "bindings":{"dictation":["RightAlt"], "translate":["RightAlt","RightShift"], "ask":["RightAlt","Space"]}, "activation":if hold {"hold"} else {"toggle"}}), 1000).unwrap();
        engine
    }

    fn events(engine: &Engine, kind: &str) -> Vec<Value> {
        engine
            .events
            .iter()
            .filter(|e| e["type"] == kind)
            .cloned()
            .collect()
    }

    #[test]
    fn idle_has_no_periodic_wakeup_even_when_toggle_recording() {
        let mut e = configured(false);
        assert_eq!(e.wait_ms(), u32::MAX);
        assert!(e.key(0xa5, true, 1000, || true));
        assert_eq!(e.wait_ms(), 25);
        assert!(e.key(0xa5, false, 1001, || true));
        assert_eq!(events(&e, "start").len(), 1);
        assert_eq!(e.wait_ms(), u32::MAX);
    }

    #[test]
    fn sub_four_ms_tap_is_not_lost_between_timer_ticks() {
        let mut e = configured(false);
        e.key(0xa5, true, 1000, || true);
        e.key(0xa5, false, 1001, || true);
        assert_eq!(events(&e, "start")[0]["mode"], "dictation");
    }

    #[test]
    fn hold_qualifier_changes_mode_and_its_release_ends_recording() {
        let mut e = configured(true);
        e.key(0xa5, true, 1000, || true);
        e.key(0x20, true, 1001, || true);
        assert_eq!(events(&e, "mode")[0]["mode"], "ask");
        e.key(0x20, false, 1002, || true);
        assert_eq!(events(&e, "stop")[0]["mode"], "ask");
    }

    #[test]
    fn qualifiers_alone_and_their_releases_reach_the_foreground() {
        let mut e = configured(false);
        for vk in [0x20, 0xa1] {
            assert!(!e.key(vk, true, 1000, || true));
            assert!(!e.key(vk, false, 1001, || true));
        }
        assert!(events(&e, "start").is_empty());
    }

    #[test]
    fn holding_and_typematic_repeat_never_toggle_a_take() {
        let mut e = configured(true);
        e.key(0xa5, true, 1000, || true);
        for at in (1250..5000).step_by(250) {
            assert!(e.key(0xa5, true, at, || true));
        }
        assert_eq!(events(&e, "start").len(), 1);
        assert!(events(&e, "stop").is_empty());
        assert!(e.key(0xa5, false, 5001, || true));
        assert_eq!(events(&e, "stop").len(), 1);
        assert!(!e.key(0xa5, false, 5002, || true)); // ownership consumed once
    }

    #[test]
    fn swallowed_key_never_seen_by_async_state_is_not_pruned() {
        let mut e = configured(true);
        e.key(0xa5, true, 1000, || true);
        e.reconcile(5000, &BTreeSet::new(), || true);
        assert!(events(&e, "stop").is_empty());
        assert!(events(&e, "stale").is_empty());
    }

    #[test]
    fn observed_lost_release_is_balanced_only_after_the_grace_period() {
        let mut e = configured(true);
        e.key(0xa5, true, 1000, || true);
        e.reconcile(1001, &BTreeSet::from([0xa5]), || true);
        e.reconcile(1150, &BTreeSet::new(), || true);
        e.reconcile(1399, &BTreeSet::new(), || true);
        assert!(events(&e, "stop").is_empty());
        e.reconcile(1400, &BTreeSet::new(), || true);
        assert_eq!(e.releases, vec![0xa5]);
        assert_eq!(events(&e, "stop").len(), 1);
        assert_eq!(e.wait_ms(), u32::MAX);
    }

    #[test]
    fn secure_desktop_release_cannot_start_an_unrequested_take() {
        let mut e = configured(false);
        e.key(0xa5, true, 1000, || true);
        e.key(0xa5, false, 1100, || false);
        assert!(events(&e, "start").is_empty());
    }

    #[test]
    fn non_swallowed_key_gets_async_update_grace() {
        let mut e = configured(false);
        e.key(0xa2, true, 1000, || true);
        e.reconcile(1149, &BTreeSet::new(), || true);
        assert_eq!(e.pressed_keys(), vec![0xa2]);
        e.reconcile(1150, &BTreeSet::new(), || true);
        assert!(e.pressed_keys().is_empty());
        assert!(e.releases.is_empty());
    }

    #[test]
    fn capture_repeat_and_release_pair_survive_capture_exit() {
        let mut e = configured(false);
        e.command(&json!({"type":"capture","active":true}), 1000)
            .unwrap();
        assert!(e.key(0xa1, true, 1001, || true));
        assert!(e.key(0xa1, true, 1002, || true));
        assert_eq!(events(&e, "capture-key").len(), 1);
        e.command(&json!({"type":"capture","active":false}), 1003)
            .unwrap();
        assert!(e.key(0xa1, false, 1004, || true));
        assert!(!e.key(0xa1, false, 1005, || true));
        assert!(events(&e, "start").is_empty());
    }

    #[test]
    fn rejected_start_acknowledgement_drops_the_ghost_recording() {
        let mut e = configured(false);
        e.key(0xa5, true, 1000, || true);
        e.key(0xa5, false, 1001, || true);
        e.command(&json!({"type":"activity","value":"working"}), 1002)
            .unwrap();
        e.key(0xa5, true, 1003, || true);
        e.key(0xa5, false, 1004, || true);
        assert_eq!(events(&e, "start").len(), 2);
        assert!(events(&e, "stop").is_empty());
    }

    #[test]
    fn disabling_hold_stops_once_and_discards_pending_gesture() {
        let mut e = configured(true);
        e.key(0xa5, true, 1000, || true);
        e.command(&json!({"type":"enabled","value":false}), 1001)
            .unwrap();
        e.key(0xa5, false, 1002, || true);
        assert_eq!(events(&e, "stop").len(), 1);
        assert_eq!(events(&e, "start").len(), 1);
    }

    #[test]
    fn escape_closes_inactive_card_and_balances_its_release() {
        let mut e = configured(false);
        e.command(&json!({"type":"card","open":true}), 1000)
            .unwrap();
        assert!(e.key(0x1b, true, 1001, || true));
        assert!(e.key(0x1b, false, 1002, || true));
        assert_eq!(events(&e, "esc").len(), 1);
        assert_eq!(events(&e, "cancel").len(), 1);
    }

    #[test]
    fn token_mapping_roundtrips_named_and_printable_keys() {
        for vk in [
            8, 9, 13, 0x14, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x24, 0x2d, 0x2e, 0x30, 0x39, 0x41, 0x5a,
            0x5b, 0x5c, 0x70, 0x7b, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5,
        ] {
            assert_eq!(token_to_vk(&vk_to_token(vk).unwrap()).unwrap(), vk);
        }
        assert!(token_to_vk("a").is_err());
        assert!(token_to_vk("F13").is_err());
        assert!(token_to_vk("not-a-key").is_err());
        assert_eq!(physical_vk(0x10, 0x36, 0), 0xa1);
        assert_eq!(physical_vk(0x11, 0, 1), 0xa3);
        assert_eq!(physical_vk(0x12, 0, 1), 0xa5);
    }
}
