// Wake phrase matching: the rules the PowerShell host already applies, kept in one
// place so they can be tested without a recogniser.
//
// Text matching uses a compatibility-folded, separator-free form of each word ("lucy",
// "你好胡小杨"). Pronunciations are the raw SAPI phone ids the engine reports, minus
// tone/format marks, which is exactly what the PowerShell host stores in a trained
// variant, so existing training data keeps working without migration.

const CARRY_MS: f64 = 3000.0;
const MAX_PHRASE_MS: f64 = 9000.0;
const UTTERANCE_START_MS: f64 = 600.0;

/// Compatibility-folded letters and digits only, lowercased.
pub fn match_text(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

/// Phone ids as a comparable string: marks and separators dropped.
pub fn phones(ids: &[u16]) -> String {
    ids.iter()
        .filter_map(|id| char::from_u32(u32::from(*id)))
        .filter(|character| !character.is_whitespace() && !is_mark(*character))
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn is_mark(character: char) -> bool {
    // Combining diacritical marks in the ranges the recognisers actually emit.
    matches!(u32::from(character), 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x20D0..=0x20F0)
}

/// Words of a phrase in the comparable form, empty pieces dropped.
fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(match_text)
        .filter(|word| !word.is_empty())
        .collect()
}

/// Pieces before a silence gap. Multi-word phrases are cut on word boundaries, single
/// tokens on characters, because a Chinese phrase arrives as one token with no
/// separators. A piece never wakes anything on its own.
pub fn leading_pieces(text: &str) -> Vec<String> {
    let words = words(text);
    if words.len() > 1 {
        return (1..words.len())
            .map(|take| words[..take].join(" "))
            .collect();
    }
    match words.first() {
        Some(word) => {
            let flat: Vec<char> = word.chars().collect();
            (2..flat.len())
                .map(|take| flat[..take].iter().collect())
                .collect()
        }
        None => Vec::new(),
    }
}

pub fn trailing_pieces(text: &str) -> Vec<String> {
    let words = words(text);
    if words.len() > 1 {
        return (1..words.len())
            .map(|from| words[from..].join(" "))
            .collect();
    }
    match words.first() {
        Some(word) => {
            let flat: Vec<char> = word.chars().collect();
            (1..flat.len().saturating_sub(1))
                .map(|from| flat[from..].iter().collect())
                .collect()
        }
        None => Vec::new(),
    }
}

#[derive(Clone, Debug)]
pub struct Word {
    pub text: String,
    pub phones: String,
    pub confidence: f32,
    /// Length of this word inside the result, from the engine's element timings.
    pub duration_ms: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    /// Phrase completed by this result.
    Wake { confidence: f32, duration_ms: f64 },
    /// Prefix of the phrase; the next result may continue it.
    Pending,
    /// Not a wake and not a usable prefix.
    Ignore,
}

#[derive(Clone, Debug)]
struct Pending {
    text: String,
    phones: String,
    confidence: f32,
    words: usize,
    start_ms: f64,
    end_ms: f64,
}

pub struct Tracker {
    targets: Vec<String>,
    phone_targets: Vec<String>,
    pending: Option<Pending>,
    silence_ms: f64,
}

impl Tracker {
    pub fn new(phrase: &str, variants: &[(String, String)]) -> Self {
        let mut targets: Vec<String> = vec![match_text(phrase)];
        let mut phone_targets: Vec<String> = Vec::new();
        for (text, phone) in variants {
            targets.push(match_text(text));
            if !phone.is_empty() {
                phone_targets.push(phone.clone());
            }
        }
        targets.retain(|target| !target.is_empty());
        Tracker {
            targets,
            phone_targets,
            pending: None,
            silence_ms: 0.0,
        }
    }

    /// Called from the audio level event; positions are milliseconds on the input stream.
    pub fn note_level(&mut self, level: u32, position_ms: f64) {
        if level == 0 {
            self.silence_ms = position_ms;
        }
    }

    pub fn on_result(
        &mut self,
        words: &[Word],
        start_ms: f64,
        duration_ms: f64,
        engine_confidence: f32,
    ) -> Outcome {
        if words.is_empty() {
            return Outcome::Ignore;
        }
        let carry = match &self.pending {
            Some(pending) => start_ms >= pending.end_ms && start_ms - pending.end_ms <= CARRY_MS,
            None => false,
        };
        // A wake word starts the utterance it belongs to. Without that rule the pieces
        // either side of a gap would also match the phrase inside a longer sentence.
        if !carry && start_ms - self.silence_ms > UTTERANCE_START_MS {
            return Outcome::Ignore;
        }
        let (mut text, mut phones, mut confidence, mut count, began) = match (&self.pending, carry)
        {
            (Some(pending), true) => (
                pending.text.clone(),
                pending.phones.clone(),
                pending.confidence,
                pending.words,
                pending.start_ms,
            ),
            _ => (String::new(), String::new(), 0.0, 0, start_ms),
        };
        self.pending = None;
        let mut spent_ms = 0.0;
        for (index, word) in words.iter().enumerate() {
            spent_ms += word.duration_ms;
            count += 1;
            confidence += word.confidence;
            text.push_str(&word.text);
            phones.push_str(&word.phones);
            let matched = self.targets.contains(&text) || self.phone_targets.contains(&phones);
            if matched {
                let duration = (start_ms - began).max(0.0)
                    + if index + 1 == words.len() {
                        duration_ms
                    } else {
                        spent_ms
                    };
                let confidence = if carry || index + 1 < words.len() {
                    confidence / count as f32
                } else {
                    engine_confidence
                };
                return Outcome::Wake {
                    confidence,
                    duration_ms: duration,
                };
            }
            let prefix = self.targets.iter().any(|target| target.starts_with(&text))
                || self
                    .phone_targets
                    .iter()
                    .any(|target| target.starts_with(&phones));
            if !prefix {
                return Outcome::Ignore;
            }
        }
        let end_ms = start_ms + duration_ms;
        if end_ms - began < MAX_PHRASE_MS {
            self.pending = Some(Pending {
                text,
                phones,
                confidence,
                words: count,
                start_ms: began,
                end_ms,
            });
            return Outcome::Pending;
        }
        Outcome::Ignore
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, phone: &str) -> Word {
        Word {
            text: match_text(text),
            phones: phone.to_string(),
            confidence: 0.9,
            duration_ms: 400.0,
        }
    }

    #[test]
    fn folds_text_and_phone_marks() {
        assert_eq!(match_text("你好，胡小杨！"), "你好胡小杨");
        assert_eq!(match_text("Hey, Jarvis!"), "heyjarvis");
        assert_eq!(phones(&[0x6E, 0x69, 0x0301, 0x307, 0x68, 0x61]), "niha");
    }

    #[test]
    fn cuts_pieces_on_word_boundaries_for_multi_word_phrases() {
        assert_eq!(leading_pieces("hey jarvis"), vec!["hey"]);
        assert_eq!(trailing_pieces("hey jarvis"), vec!["jarvis"]);
        assert_eq!(
            leading_pieces("你好，胡小杨"),
            vec!["你好", "你好胡", "你好胡小"]
        );
        assert_eq!(
            trailing_pieces("你好，胡小杨"),
            vec!["好胡小杨", "胡小杨", "小杨"]
        );
    }

    #[test]
    fn wakes_on_the_complete_phrase_only() {
        let mut tracker = Tracker::new("你好，胡小杨", &[]);
        let phrase = vec![word("你好胡小杨", "")];
        assert!(matches!(
            tracker.on_result(&phrase, 80.0, 1200.0, 0.98),
            Outcome::Wake { .. }
        ));
        let partial = vec![word("你好", "")];
        let mut tracker = Tracker::new("你好，胡小杨", &[]);
        assert_eq!(
            tracker.on_result(&partial, 80.0, 500.0, 0.9),
            Outcome::Pending
        );
        let stray = vec![word("今天下午", "")];
        assert_eq!(tracker.on_result(&stray, 80.0, 500.0, 0.9), Outcome::Ignore);
    }

    #[test]
    fn joins_prefixes_across_a_short_gap_and_rejects_long_ones() {
        let mut tracker = Tracker::new("你好，阿语", &[]);
        assert_eq!(
            tracker.on_result(&[word("你好", "")], 80.0, 400.0, 0.97),
            Outcome::Pending
        );
        let outcome = tracker.on_result(&[word("阿语", "")], 700.0, 600.0, 0.98);
        match outcome {
            Outcome::Wake { duration_ms, .. } => assert!((duration_ms - 1220.0).abs() < 1.0),
            other => panic!("expected wake, got {other:?}"),
        }
        let mut tracker = Tracker::new("你好，阿语", &[]);
        assert_eq!(
            tracker.on_result(&[word("你好", "")], 80.0, 400.0, 0.97),
            Outcome::Pending
        );
        assert_eq!(
            tracker.on_result(&[word("阿语", "")], 4000.0, 600.0, 0.98),
            Outcome::Ignore
        );
    }

    #[test]
    fn ignores_a_phrase_that_does_not_start_the_utterance() {
        let mut tracker = Tracker::new("你好，胡小杨", &[]);
        tracker.note_level(0, 0.0);
        assert!(matches!(
            tracker.on_result(&[word("你好胡小杨", "")], 80.0, 1000.0, 0.99),
            Outcome::Wake { .. }
        ));
        let mut tracker = Tracker::new("你好，胡小杨", &[]);
        tracker.note_level(0, 40.0);
        assert_eq!(
            tracker.on_result(&[word("你好胡小杨", "")], 2550.0, 1240.0, 0.99),
            Outcome::Ignore
        );
    }

    #[test]
    fn accepts_trained_variants_by_text_or_phones() {
        let variants = vec![("你好晓阳".to_string(), "ni3hao3xiao3yang2".to_string())];
        let mut tracker = Tracker::new("你好，胡小杨", &variants);
        assert!(matches!(
            tracker.on_result(&[word("你好晓阳", "")], 80.0, 900.0, 0.95),
            Outcome::Wake { .. }
        ));
        let mut tracker = Tracker::new("你好，胡小杨", &variants);
        let by_phone = vec![word("你好小羊", "ni3hao3xiao3yang2")];
        assert!(matches!(
            tracker.on_result(&by_phone, 80.0, 900.0, 0.95),
            Outcome::Wake { .. }
        ));
    }
}
