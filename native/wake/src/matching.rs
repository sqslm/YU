// Wake phrase matching: the rules the PowerShell host already applies, kept in one
// place so they can be tested without a recogniser.
//
// Text matching uses the NFKC form of each word with separators removed ("lucy",
// "你好胡小杨"), so full-width letters and digits fold like the PowerShell host's
// `MatchText`. Pronunciations are the recogniser's IPA string in the form
// `System.Speech` stores in `Pronunciation`: the engine's phone ids are converted to UPS by
// `ISpPhoneticAlphabetConverter::SAPI2UPS` (System.Speech reaches the same characters from
// the same ids through its own table), then decomposed with FormD and stripped of marks and
// separators, which is what the PowerShell host stores in a trained variant. The equality is
// checked against the host's real output, not assumed from the API name.

const CARRY_MS: f64 = 3000.0;
const MAX_PHRASE_MS: f64 = 9000.0;
const UTTERANCE_START_MS: f64 = 600.0;

/// Unicode normalisation through Win32; returns the input unchanged if it fails.
fn normalize(text: &str, form: windows::Win32::Globalization::NORM_FORM) -> String {
    use windows::Win32::Globalization::NormalizeString;
    let source: Vec<u16> = text.encode_utf16().collect();
    let needed = unsafe { NormalizeString(form, &source, None) };
    if needed <= 0 {
        return text.to_string();
    }
    let mut destination = vec![0u16; needed as usize];
    let written = unsafe { NormalizeString(form, &source, Some(&mut destination)) };
    if written <= 0 {
        return text.to_string();
    }
    String::from_utf16_lossy(&destination[..written as usize])
}

/// NFKC-folded letters and digits only, lowercased.
pub fn match_text(text: &str) -> String {
    normalize(text, windows::Win32::Globalization::NormalizationKC)
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

/// Recogniser IPA as a comparable string: FormD, then marks and separators dropped, then
/// lowercased. This mirrors the PowerShell host's `Phones`, which normalises with FormD and
/// removes `[\p{M}\s]`; a trained variant stores that exact string.
pub fn phones(ipa: &str) -> String {
    normalize(ipa, windows::Win32::Globalization::NormalizationD)
        .chars()
        .filter(|character| !character.is_whitespace() && !is_mark(*character))
        .flat_map(|character| character.to_lowercase())
        .collect()
}

/// Unicode general category Mark (Mn, Mc, Me), generated from the Unicode 15.1 database.
/// `char` methods in std do not expose the category, and Windows' `CT_CTYPE3` classification
/// both misses marks and flags ordinary letters, so the ranges are kept here.
const MARK_RANGES: &[core::ops::RangeInclusive<u32>] = &[
    0x0300..=0x036F,
    0x0483..=0x0489,
    0x0591..=0x05BD,
    0x05BF..=0x05BF,
    0x05C1..=0x05C2,
    0x05C4..=0x05C5,
    0x05C7..=0x05C7,
    0x0610..=0x061A,
    0x064B..=0x065F,
    0x0670..=0x0670,
    0x06D6..=0x06DC,
    0x06DF..=0x06E4,
    0x06E7..=0x06E8,
    0x06EA..=0x06ED,
    0x0711..=0x0711,
    0x0730..=0x074A,
    0x07A6..=0x07B0,
    0x07EB..=0x07F3,
    0x07FD..=0x07FD,
    0x0816..=0x0819,
    0x081B..=0x0823,
    0x0825..=0x0827,
    0x0829..=0x082D,
    0x0859..=0x085B,
    0x0898..=0x089F,
    0x08CA..=0x08E1,
    0x08E3..=0x0903,
    0x093A..=0x093C,
    0x093E..=0x094F,
    0x0951..=0x0957,
    0x0962..=0x0963,
    0x0981..=0x0983,
    0x09BC..=0x09BC,
    0x09BE..=0x09C4,
    0x09C7..=0x09C8,
    0x09CB..=0x09CD,
    0x09D7..=0x09D7,
    0x09E2..=0x09E3,
    0x09FE..=0x09FE,
    0x0A01..=0x0A03,
    0x0A3C..=0x0A3C,
    0x0A3E..=0x0A42,
    0x0A47..=0x0A48,
    0x0A4B..=0x0A4D,
    0x0A51..=0x0A51,
    0x0A70..=0x0A71,
    0x0A75..=0x0A75,
    0x0A81..=0x0A83,
    0x0ABC..=0x0ABC,
    0x0ABE..=0x0AC5,
    0x0AC7..=0x0AC9,
    0x0ACB..=0x0ACD,
    0x0AE2..=0x0AE3,
    0x0AFA..=0x0AFF,
    0x0B01..=0x0B03,
    0x0B3C..=0x0B3C,
    0x0B3E..=0x0B44,
    0x0B47..=0x0B48,
    0x0B4B..=0x0B4D,
    0x0B55..=0x0B57,
    0x0B62..=0x0B63,
    0x0B82..=0x0B82,
    0x0BBE..=0x0BC2,
    0x0BC6..=0x0BC8,
    0x0BCA..=0x0BCD,
    0x0BD7..=0x0BD7,
    0x0C00..=0x0C04,
    0x0C3C..=0x0C3C,
    0x0C3E..=0x0C44,
    0x0C46..=0x0C48,
    0x0C4A..=0x0C4D,
    0x0C55..=0x0C56,
    0x0C62..=0x0C63,
    0x0C81..=0x0C83,
    0x0CBC..=0x0CBC,
    0x0CBE..=0x0CC4,
    0x0CC6..=0x0CC8,
    0x0CCA..=0x0CCD,
    0x0CD5..=0x0CD6,
    0x0CE2..=0x0CE3,
    0x0CF3..=0x0CF3,
    0x0D00..=0x0D03,
    0x0D3B..=0x0D3C,
    0x0D3E..=0x0D44,
    0x0D46..=0x0D48,
    0x0D4A..=0x0D4D,
    0x0D57..=0x0D57,
    0x0D62..=0x0D63,
    0x0D81..=0x0D83,
    0x0DCA..=0x0DCA,
    0x0DCF..=0x0DD4,
    0x0DD6..=0x0DD6,
    0x0DD8..=0x0DDF,
    0x0DF2..=0x0DF3,
    0x0E31..=0x0E31,
    0x0E34..=0x0E3A,
    0x0E47..=0x0E4E,
    0x0EB1..=0x0EB1,
    0x0EB4..=0x0EBC,
    0x0EC8..=0x0ECE,
    0x0F18..=0x0F19,
    0x0F35..=0x0F35,
    0x0F37..=0x0F37,
    0x0F39..=0x0F39,
    0x0F3E..=0x0F3F,
    0x0F71..=0x0F84,
    0x0F86..=0x0F87,
    0x0F8D..=0x0F97,
    0x0F99..=0x0FBC,
    0x0FC6..=0x0FC6,
    0x102B..=0x103E,
    0x1056..=0x1059,
    0x105E..=0x1060,
    0x1062..=0x1064,
    0x1067..=0x106D,
    0x1071..=0x1074,
    0x1082..=0x108D,
    0x108F..=0x108F,
    0x109A..=0x109D,
    0x135D..=0x135F,
    0x1712..=0x1715,
    0x1732..=0x1734,
    0x1752..=0x1753,
    0x1772..=0x1773,
    0x17B4..=0x17D3,
    0x17DD..=0x17DD,
    0x180B..=0x180D,
    0x180F..=0x180F,
    0x1885..=0x1886,
    0x18A9..=0x18A9,
    0x1920..=0x192B,
    0x1930..=0x193B,
    0x1A17..=0x1A1B,
    0x1A55..=0x1A5E,
    0x1A60..=0x1A7C,
    0x1A7F..=0x1A7F,
    0x1AB0..=0x1ACE,
    0x1B00..=0x1B04,
    0x1B34..=0x1B44,
    0x1B6B..=0x1B73,
    0x1B80..=0x1B82,
    0x1BA1..=0x1BAD,
    0x1BE6..=0x1BF3,
    0x1C24..=0x1C37,
    0x1CD0..=0x1CD2,
    0x1CD4..=0x1CE8,
    0x1CED..=0x1CED,
    0x1CF4..=0x1CF4,
    0x1CF7..=0x1CF9,
    0x1DC0..=0x1DFF,
    0x20D0..=0x20F0,
    0x2CEF..=0x2CF1,
    0x2D7F..=0x2D7F,
    0x2DE0..=0x2DFF,
    0x302A..=0x302F,
    0x3099..=0x309A,
    0xA66F..=0xA672,
    0xA674..=0xA67D,
    0xA69E..=0xA69F,
    0xA6F0..=0xA6F1,
    0xA802..=0xA802,
    0xA806..=0xA806,
    0xA80B..=0xA80B,
    0xA823..=0xA827,
    0xA82C..=0xA82C,
    0xA880..=0xA881,
    0xA8B4..=0xA8C5,
    0xA8E0..=0xA8F1,
    0xA8FF..=0xA8FF,
    0xA926..=0xA92D,
    0xA947..=0xA953,
    0xA980..=0xA983,
    0xA9B3..=0xA9C0,
    0xA9E5..=0xA9E5,
    0xAA29..=0xAA36,
    0xAA43..=0xAA43,
    0xAA4C..=0xAA4D,
    0xAA7B..=0xAA7D,
    0xAAB0..=0xAAB0,
    0xAAB2..=0xAAB4,
    0xAAB7..=0xAAB8,
    0xAABE..=0xAABF,
    0xAAC1..=0xAAC1,
    0xAAEB..=0xAAEF,
    0xAAF5..=0xAAF6,
    0xABE3..=0xABEA,
    0xABEC..=0xABED,
    0xFB1E..=0xFB1E,
    0xFE00..=0xFE0F,
    0xFE20..=0xFE2F,
    0x101FD..=0x101FD,
    0x102E0..=0x102E0,
    0x10376..=0x1037A,
    0x10A01..=0x10A03,
    0x10A05..=0x10A06,
    0x10A0C..=0x10A0F,
    0x10A38..=0x10A3A,
    0x10A3F..=0x10A3F,
    0x10AE5..=0x10AE6,
    0x10D24..=0x10D27,
    0x10EAB..=0x10EAC,
    0x10EFD..=0x10EFF,
    0x10F46..=0x10F50,
    0x10F82..=0x10F85,
    0x11000..=0x11002,
    0x11038..=0x11046,
    0x11070..=0x11070,
    0x11073..=0x11074,
    0x1107F..=0x11082,
    0x110B0..=0x110BA,
    0x110C2..=0x110C2,
    0x11100..=0x11102,
    0x11127..=0x11134,
    0x11145..=0x11146,
    0x11173..=0x11173,
    0x11180..=0x11182,
    0x111B3..=0x111C0,
    0x111C9..=0x111CC,
    0x111CE..=0x111CF,
    0x1122C..=0x11237,
    0x1123E..=0x1123E,
    0x11241..=0x11241,
    0x112DF..=0x112EA,
    0x11300..=0x11303,
    0x1133B..=0x1133C,
    0x1133E..=0x11344,
    0x11347..=0x11348,
    0x1134B..=0x1134D,
    0x11357..=0x11357,
    0x11362..=0x11363,
    0x11366..=0x1136C,
    0x11370..=0x11374,
    0x11435..=0x11446,
    0x1145E..=0x1145E,
    0x114B0..=0x114C3,
    0x115AF..=0x115B5,
    0x115B8..=0x115C0,
    0x115DC..=0x115DD,
    0x11630..=0x11640,
    0x116AB..=0x116B7,
    0x1171D..=0x1172B,
    0x1182C..=0x1183A,
    0x11930..=0x11935,
    0x11937..=0x11938,
    0x1193B..=0x1193E,
    0x11940..=0x11940,
    0x11942..=0x11943,
    0x119D1..=0x119D7,
    0x119DA..=0x119E0,
    0x119E4..=0x119E4,
    0x11A01..=0x11A0A,
    0x11A33..=0x11A39,
    0x11A3B..=0x11A3E,
    0x11A47..=0x11A47,
    0x11A51..=0x11A5B,
    0x11A8A..=0x11A99,
    0x11C2F..=0x11C36,
    0x11C38..=0x11C3F,
    0x11C92..=0x11CA7,
    0x11CA9..=0x11CB6,
    0x11D31..=0x11D36,
    0x11D3A..=0x11D3A,
    0x11D3C..=0x11D3D,
    0x11D3F..=0x11D45,
    0x11D47..=0x11D47,
    0x11D8A..=0x11D8E,
    0x11D90..=0x11D91,
    0x11D93..=0x11D97,
    0x11EF3..=0x11EF6,
    0x11F00..=0x11F01,
    0x11F03..=0x11F03,
    0x11F34..=0x11F3A,
    0x11F3E..=0x11F42,
    0x13440..=0x13440,
    0x13447..=0x13455,
    0x16AF0..=0x16AF4,
    0x16B30..=0x16B36,
    0x16F4F..=0x16F4F,
    0x16F51..=0x16F87,
    0x16F8F..=0x16F92,
    0x16FE4..=0x16FE4,
    0x16FF0..=0x16FF1,
    0x1BC9D..=0x1BC9E,
    0x1CF00..=0x1CF2D,
    0x1CF30..=0x1CF46,
    0x1D165..=0x1D169,
    0x1D16D..=0x1D172,
    0x1D17B..=0x1D182,
    0x1D185..=0x1D18B,
    0x1D1AA..=0x1D1AD,
    0x1D242..=0x1D244,
    0x1DA00..=0x1DA36,
    0x1DA3B..=0x1DA6C,
    0x1DA75..=0x1DA75,
    0x1DA84..=0x1DA84,
    0x1DA9B..=0x1DA9F,
    0x1DAA1..=0x1DAAF,
    0x1E000..=0x1E006,
    0x1E008..=0x1E018,
    0x1E01B..=0x1E021,
    0x1E023..=0x1E024,
    0x1E026..=0x1E02A,
    0x1E08F..=0x1E08F,
    0x1E130..=0x1E136,
    0x1E2AE..=0x1E2AE,
    0x1E2EC..=0x1E2EF,
    0x1E4EC..=0x1E4EF,
    0x1E8D0..=0x1E8D6,
    0x1E944..=0x1E94A,
    0xE0100..=0xE01EF,
];

fn is_mark(character: char) -> bool {
    let code = u32::from(character);
    MARK_RANGES
        .binary_search_by(|range| {
            if code < *range.start() {
                std::cmp::Ordering::Greater
            } else if code > *range.end() {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
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
            // An empty accumulated string prefixes everything, so it never counts as one.
            let prefix = (!text.is_empty()
                && self.targets.iter().any(|target| target.starts_with(&text)))
                || (!phones.is_empty()
                    && self
                        .phone_targets
                        .iter()
                        .any(|target| target.starts_with(&phones)));
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
        // NFKC folds the full-width forms the engine can return.
        assert_eq!(match_text("Ｈｅｙ　Ｊａｒｖｉｓ"), "heyjarvis");
        // NFKD plus mark removal: an accented vowel compares equal to its base.
        assert_eq!(phones("ni\u{301}ha"), "niha");
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
    fn accepts_a_trained_variant_by_its_text() {
        let variants = vec![("你好晓阳".to_string(), String::new())];
        let mut tracker = Tracker::new("你好，胡小杨", &variants);
        assert!(matches!(
            tracker.on_result(&[word("你好晓阳", "")], 80.0, 900.0, 0.95),
            Outcome::Wake { .. }
        ));
    }

    /// The UPS the recogniser returns for the phrase, captured from a real run:
    ///
    /// ```text
    /// native/wake/target/release/phone_probe.exe e7 b 81 c 88 b 169 c 175 b
    /// ups text: ni̋hãʊ̀̏̄huɕjãʊ̀̏̄jɑ̃ŋ̋
    /// ```
    ///
    /// The phone ids are the ones `speech.rs` reads from the recogniser for
    /// `你好胡小杨` (see `tests/yu-v2/evidence/rust-wake-phoneme-compat.json`).
    const ENGINE_UPS: &str = "ni\u{304}\u{30b}ha\u{361}\u{28a}\u{300}\u{30f}\u{304}hu\u{304}\u{30b}\u{255}ja\u{361}\u{28a}\u{300}\u{30f}\u{304}j\u{251}\u{361}\u{14b}\u{304}\u{30b}";

    /// What `resources/voice-wake.ps1` stored in a trained variant for the same audio:
    /// `{"text":"你好胡晓阳","phones":"nihaʊhuɕjaʊjɑŋ"}` from `mode:"learn"` on a Huihui
    /// sample of `你好，胡晓阳。`.
    const LEARNED_IPA: &str = "niha\u{28a}hu\u{255}ja\u{28a}j\u{251}\u{14b}";

    #[test]
    fn converts_engine_phones_to_the_stored_ipa_form() {
        assert_eq!(phones(ENGINE_UPS), LEARNED_IPA);
    }

    /// A variant learned by the PowerShell host wakes on real recogniser output whose text
    /// differs from every target, so only the pronunciation can have matched. The phrase is
    /// empty, which leaves no text target at all; production always supplies one.
    #[test]
    fn wakes_on_a_learned_variant_through_phones_alone() {
        let variants = vec![("你好胡晓阳".to_string(), LEARNED_IPA.to_string())];
        let recognized = vec![Word {
            text: match_text("你好胡小杨"),
            phones: phones(ENGINE_UPS),
            confidence: 0.99,
            duration_ms: 1330.0,
        }];
        let mut tracker = Tracker::new("", &variants);
        assert!(matches!(
            tracker.on_result(&recognized, 80.0, 1330.0, 0.99),
            Outcome::Wake { .. }
        ));
        // The same result without the pronunciation must not wake, which shows the text
        // branch took no part above.
        let mut tracker = Tracker::new("", &variants);
        let mut silent = recognized.clone();
        silent[0].phones.clear();
        assert_eq!(
            tracker.on_result(&silent, 80.0, 1330.0, 0.99),
            Outcome::Ignore
        );
    }
}
