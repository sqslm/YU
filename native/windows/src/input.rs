use serde_json::Value;

pub fn window_handle(request: &Value) -> Result<usize, &'static str> {
    let text = request["handle"]
        .as_str()
        .ok_or("Original window is unavailable")?;
    if text.is_empty() || !text.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Original window is unavailable");
    }
    text.parse::<usize>()
        .ok()
        .filter(|&v| v != 0 && v <= isize::MAX as usize)
        .ok_or("Original window is unavailable")
}

pub fn volume(request: &Value) -> Result<(Option<u32>, Option<bool>), &'static str> {
    let level = match request.get("volume").filter(|v| !v.is_null()) {
        Some(value) => Some(
            value
                .as_u64()
                .filter(|&n| n <= 100)
                .ok_or("Volume must be 0-100")? as u32,
        ),
        None => None,
    };
    let mute = match request.get("muted").filter(|v| !v.is_null()) {
        Some(value) => Some(value.as_bool().ok_or("Muted must be boolean")?),
        None => None,
    };
    Ok((level, mute))
}

// Preserve the old script's three whitespace rules; keep English spacing intact.
pub fn ocr_line(text: &str) -> String {
    let chars: Vec<char> = text.trim().chars().collect();
    let mut output = String::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_whitespace() {
            output.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let before = chars[start - 1];
        let after = chars[i];
        let cjk = |c| ('\u{4e00}'..='\u{9fff}').contains(&c);
        if (cjk(before) && cjk(after))
            || "，。！？；：、）》】」』".contains(after)
            || "，。！？；：、（《【「『".contains(before)
        {
            continue;
        }
        output.extend(&chars[start..i]);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_accepts_positive_decimal_window_handles() {
        assert_eq!(window_handle(&json!({"handle":"123"})), Ok(123));
        for value in [
            json!(null),
            json!(123),
            json!(""),
            json!("0"),
            json!("-1"),
            json!("+1"),
            json!("0x123"),
            json!("123 "),
            json!("18446744073709551616"),
        ] {
            assert!(window_handle(&json!({"handle":value})).is_err());
        }
    }
    #[test]
    fn validates_every_volume_field_before_any_audio_write() {
        assert_eq!(volume(&json!({})), Ok((None, None)));
        assert_eq!(
            volume(&json!({"volume":0,"muted":false})),
            Ok((Some(0), Some(false)))
        );
        assert_eq!(
            volume(&json!({"volume":100,"muted":true})),
            Ok((Some(100), Some(true)))
        );
        for value in [json!(-1), json!(101), json!(1.5), json!("50"), json!(true)] {
            assert!(volume(&json!({"volume":value})).is_err());
        }
        assert!(volume(&json!({"volume":50,"muted":"false"})).is_err());
    }
    #[test]
    fn normalizes_chinese_words_and_punctuation_without_collapsing_english() {
        for (input, expected) in [
            ("  你 好 ， 世 界 。  ", "你好，世界。"),
            ("hello  world 123", "hello  world 123"),
            ("中 文 English 123", "中文 English 123"),
            ("（ 你 好 ）", "（你好）"),
            ("Hello， world！ Next", "Hello，world！Next"),
            ("", ""),
            ("😀 hello", "😀 hello"),
        ] {
            assert_eq!(ocr_line(input), expected);
        }
    }
}
