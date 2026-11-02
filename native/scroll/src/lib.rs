use std::slice;

const MAX_PIXELS: usize = 40_000_000;

#[derive(Debug, PartialEq)]
struct Match {
    offset: usize,
    top: usize,
    bottom: usize,
}

struct Frames<'a> {
    previous: &'a [u8],
    next: &'a [u8],
    width: usize,
    height: usize,
}

impl Frames<'_> {
    fn margin(&self) -> usize {
        1.max((self.width as f64 * 0.03).floor() as usize)
    }

    fn columns(&self) -> impl Iterator<Item = usize> {
        (self.margin()..self.width.saturating_sub(self.margin())).step_by(1.max(self.width / 64))
    }

    fn changed(&self, row: usize, x: usize) -> bool {
        let i = (row * self.width + x) * 4;
        (0..3)
            .map(|c| self.previous[i + c].abs_diff(self.next[i + c]) as u32)
            .sum::<u32>()
            > 12
    }

    fn difference(&self, offset: usize, top: usize, bottom: usize, changed: Option<&[u8]>) -> f64 {
        let mut sums = [0usize; 3];
        let mut counts = [0usize; 3];
        let mut possible = [0usize; 3];
        let overlap = self.height - offset - bottom;
        let columns = self.columns().count();
        for y in (top..overlap).step_by(1.max((overlap - top) / 28)) {
            let band = 2.min((y - top) * 3 / (overlap - top));
            for (column, x) in self.columns().enumerate() {
                if let Some(mask) = changed {
                    let a = mask[(y + offset) * columns + column] != 0;
                    let b = mask[y * columns + column] != 0;
                    possible[band] += usize::from(a || b);
                    if !a || !b {
                        continue;
                    }
                }
                let a = ((y + offset) * self.width + x) * 4;
                let b = (y * self.width + x) * 4;
                for c in 0..3 {
                    sums[band] += 30.min(self.previous[a + c].abs_diff(self.next[b + c])) as usize;
                    counts[band] += 1;
                }
            }
        }
        if changed.is_none() {
            return sums.iter().sum::<usize>() as f64 / counts.iter().sum::<usize>().max(1) as f64;
        }
        if (0..3).any(|b| counts[b] < 12 || (counts[b] as f64) < possible[b] as f64 * 0.6) {
            return f64::INFINITY;
        }
        let mut scores = std::array::from_fn::<_, 3, _>(|b| sums[b] as f64 / counts[b] as f64);
        scores.sort_by(f64::total_cmp);
        scores[1]
    }

    fn stationary_edge(&self, bottom: bool) -> usize {
        for row in 0..self.height / 3 {
            let y = if bottom { self.height - row - 1 } else { row };
            let (mut sum, mut count) = (0usize, 0usize);
            for x in (2..self.width.saturating_sub(2)).step_by(1.max(self.width / 64)) {
                let i = (y * self.width + x) * 4;
                for c in 0..3 {
                    sum += self.previous[i + c].abs_diff(self.next[i + c]) as usize;
                    count += 1;
                }
            }
            if sum as f64 / count.max(1) as f64 > 2.0 {
                return if row > 1 { row } else { 0 };
            }
        }
        0
    }

    fn find(&self) -> Option<Match> {
        if self.difference(0, 0, 0, None) < 0.5 {
            return Some(Match {
                offset: 0,
                top: 0,
                bottom: 0,
            });
        }
        let top = self.stationary_edge(false);
        let bottom = self.stationary_edge(true);
        let content_height = self.height - top - bottom;
        let unchanged = self.difference(0, top, bottom, None);
        // Scoring reads only these columns. Avoid a width*height allocation/pass.
        let mut changed = Vec::with_capacity(self.columns().count() * self.height);
        for y in 0..self.height {
            for x in self.columns() {
                changed.push(u8::from(self.changed(y, x)));
            }
        }
        let maximum =
            content_height.saturating_sub(24.max((content_height as f64 * 0.2).ceil() as usize));
        let mut scores = Vec::with_capacity(maximum);
        let (mut best, mut offset) = (f64::INFINITY, 0usize);
        for step in 1..=maximum {
            let score = self.difference(step, top, bottom, Some(&changed));
            scores.push(score);
            if score < best {
                best = score;
                offset = step;
            }
        }
        let second = scores
            .iter()
            .enumerate()
            .filter(|(index, _)| (index + 1).abs_diff(offset) > 2)
            .map(|(_, &score)| score)
            .fold(f64::INFINITY, f64::min);
        (best < 3.0 && best + 0.5 < unchanged && best + 0.25 < second).then_some(Match {
            offset,
            top,
            bottom,
        })
    }
}

/// Returns 1 for a match (offset/top/bottom), 0 for no match, -1 for invalid input.
/// No pointers are retained, no input pixels are changed, and no OS APIs are used.
///
/// # Safety
/// Non-null input pointers must be readable for their declared byte lengths for
/// the synchronous call, with no concurrent mutation. `result` must point to
/// three writable aligned u32 values, disjoint from the input allocations.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn yu_scroll_match(
    previous: *const u8,
    previous_len: usize,
    next: *const u8,
    next_len: usize,
    width: u32,
    height: u32,
    result: *mut u32,
) -> i32 {
    let (width, height) = (width as usize, height as usize);
    let pixels = width.checked_mul(height);
    if previous.is_null()
        || next.is_null()
        || result.is_null()
        || !matches!(pixels, Some(1..=MAX_PIXELS))
        || pixels.and_then(|n| n.checked_mul(4)) != Some(previous_len)
        || previous_len != next_len
    {
        return -1;
    }
    // SAFETY: caller owns both buffers throughout the call; sizes are checked.
    let frames = Frames {
        previous: unsafe { slice::from_raw_parts(previous, previous_len) },
        next: unsafe { slice::from_raw_parts(next, next_len) },
        width,
        height,
    };
    match frames.find() {
        Some(found) => {
            // SAFETY: the caller provides a separate aligned three-u32 output.
            unsafe {
                result.write(found.offset as u32);
                result.add(1).write(found.top as u32);
                result.add(2).write(found.bottom as u32);
            }
            1
        }
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(width: usize, height: usize, top: usize) -> Vec<u8> {
        let mut pixels = vec![255; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let value = ((y + top) * 1337 + x * 311 + 7 * 97) as u32;
                let shade = ((value ^ (value >> 5)).wrapping_mul(13) & 255) as u8;
                pixels[(y * width + x) * 4..(y * width + x) * 4 + 3].fill(shade);
            }
        }
        pixels
    }

    #[test]
    fn matches_downward_but_rejects_upward_or_unrelated_content() {
        let a = page(120, 100, 0);
        let b = page(120, 100, 37);
        let find = |a: &[u8], b: &[u8]| {
            Frames {
                previous: a,
                next: b,
                width: 120,
                height: 100,
            }
            .find()
        };
        assert_eq!(
            find(&a, &b),
            Some(Match {
                offset: 37,
                top: 0,
                bottom: 0
            })
        );
        assert_eq!(
            find(&a, &a),
            Some(Match {
                offset: 0,
                top: 0,
                bottom: 0
            })
        );
        assert_eq!(find(&b, &a), None);
        assert_eq!(find(&a, &page(120, 100, 200)), None);
    }

    #[test]
    fn preserves_fixed_header_and_footer() {
        let mut a = page(120, 100, 0);
        let mut b = page(120, 100, 31);
        for image in [&mut a, &mut b] {
            image[..120 * 10 * 4].fill(40);
            image[120 * 90 * 4..].fill(80);
        }
        assert_eq!(
            Frames {
                previous: &a,
                next: &b,
                width: 120,
                height: 100
            }
            .find(),
            Some(Match {
                offset: 31,
                top: 10,
                bottom: 10
            })
        );
    }

    #[test]
    fn validates_ffi_sizes_before_accessing_pointers() {
        let a = page(120, 100, 0);
        let mut result = [999u32; 3];
        unsafe {
            assert_eq!(
                yu_scroll_match(
                    a.as_ptr(),
                    a.len(),
                    a.as_ptr(),
                    a.len(),
                    120,
                    100,
                    result.as_mut_ptr()
                ),
                1
            );
            assert_eq!(result, [0, 0, 0]);
            for (width, height, length) in [
                (0, 100, a.len()),
                (120, 0, a.len()),
                (120, 100, a.len() - 1),
                (u32::MAX, u32::MAX, a.len()),
            ] {
                assert_eq!(
                    yu_scroll_match(
                        a.as_ptr(),
                        length,
                        a.as_ptr(),
                        a.len(),
                        width,
                        height,
                        result.as_mut_ptr()
                    ),
                    -1
                );
            }
            assert_eq!(
                yu_scroll_match(
                    std::ptr::null(),
                    a.len(),
                    a.as_ptr(),
                    a.len(),
                    120,
                    100,
                    result.as_mut_ptr()
                ),
                -1
            );
            assert_eq!(
                yu_scroll_match(
                    a.as_ptr(),
                    a.len(),
                    a.as_ptr(),
                    a.len(),
                    120,
                    100,
                    std::ptr::null_mut()
                ),
                -1
            );
        }
    }

    #[test]
    fn accepts_tiny_and_narrow_frames_without_panicking() {
        for width in 1..9 {
            for height in 1..30 {
                let a = page(width, height, 0);
                let b = page(width, height, 1);
                Frames {
                    previous: &a,
                    next: &b,
                    width,
                    height,
                }
                .find();
            }
        }
    }
}
