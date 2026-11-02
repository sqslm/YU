use crate::input::ocr_line;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::error::Error;
use windows::{
    Graphics::Imaging::BitmapDecoder,
    Media::Ocr::OcrEngine,
    Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
};

const MAX_IMAGE_BYTES: usize = 6 * 1024 * 1024;

fn image_bytes(request: &Value) -> Result<Vec<u8>, Box<dyn Error>> {
    let encoded = request["png"].as_str().ok_or("Invalid OCR image data")?;
    let compact: String = encoded
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if compact.is_empty() || compact.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("Invalid OCR image size".into());
    }
    let bytes = STANDARD
        .decode(compact)
        .map_err(|_| "Invalid OCR image data")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Invalid OCR image size".into());
    }
    Ok(bytes)
}

pub fn recognize(request: &Value) -> Result<Value, Box<dyn Error>> {
    let bytes = image_bytes(request)?;
    let explicit = request["language"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "auto");
    let wanted = explicit.unwrap_or("zh").to_ascii_lowercase();
    let languages = OcrEngine::AvailableRecognizerLanguages()?;
    let mut selected = None;
    for language in languages {
        if language
            .LanguageTag()?
            .to_string()
            .to_ascii_lowercase()
            .starts_with(&wanted)
        {
            selected = Some(language);
            break;
        }
    }
    if selected.is_none() && explicit.is_some() {
        return Err("Requested Windows OCR language pack is not installed".into());
    }
    let engine = selected
        .and_then(|language| OcrEngine::TryCreateFromLanguage(&language).ok())
        .or_else(|| OcrEngine::TryCreateFromUserProfileLanguages().ok())
        .ok_or("Windows OCR language support is unavailable")?;
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream.GetOutputStreamAt(0)?)?;
    writer.WriteBytes(&bytes)?;
    writer.StoreAsync()?.get()?;
    writer.DetachStream()?;
    stream.Seek(0)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    // Reject excessive dimensions before allocating a decoded bitmap.
    let width = decoder.PixelWidth()?;
    let height = decoder.PixelHeight()?;
    let maximum = OcrEngine::MaxImageDimension()?;
    if width > maximum || height > maximum {
        return Err("Image exceeds Windows OCR dimensions".into());
    }
    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
    let result = engine.RecognizeAsync(&bitmap)?.get()?;
    let mut lines = vec![];
    for line in result.Lines()? {
        let text = ocr_line(&line.Text()?.to_string());
        let words = line.Words()?;
        if text.is_empty() || words.Size()? == 0 {
            continue;
        }
        let (mut left, mut top, mut right, mut bottom) = (
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        );
        for word in words {
            let rect = word.BoundingRect()?;
            left = left.min(rect.X);
            top = top.min(rect.Y);
            right = right.max(rect.X + rect.Width);
            bottom = bottom.max(rect.Y + rect.Height);
        }
        lines.push(json!({"text":text,"x":left,"y":top,"width":right-left,"height":bottom-top}));
    }
    let text = lines
        .iter()
        .filter_map(|line| line["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let response = json!({"text":text,"lines":lines,"width":width,"height":height,"language":engine.RecognizerLanguage()?.LanguageTag()?.to_string()});
    bitmap.Close()?;
    writer.Close()?;
    stream.Close()?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_base64_whitespace_but_rejects_empty_invalid_and_oversize_payloads() {
        assert_eq!(image_bytes(&json!({"png":" YW\nJj \r\n"})).unwrap(), b"abc");
        for value in [Value::Null, json!(""), json!("?"), json!("a")] {
            assert!(image_bytes(&json!({"png":value})).is_err());
        }
        assert!(image_bytes(&json!({"png":"A".repeat(MAX_IMAGE_BYTES.div_ceil(3)*4+4)})).is_err());
        assert_eq!(
            image_bytes(&json!({"png":STANDARD.encode(vec![0; MAX_IMAGE_BYTES])}))
                .unwrap()
                .len(),
            MAX_IMAGE_BYTES
        );
    }
}
