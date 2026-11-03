//! Batch cosine scores for the local memory graph.
//!
//! The caller owns both buffers: `vectors` is a borrowed, row-major float32
//! matrix and `scores` is a caller-allocated float64 count×count matrix. Nothing
//! is allocated here, no pointer is retained, and no panic crosses the FFI
//! boundary. Accumulation stays in f64 and in dimension order, so the scores are
//! bit-identical to the JavaScript loop this replaces.

/// Largest accepted node count; the output matrix is count² float64 values.
const MAX_COUNT: usize = 4096;
/// Largest accepted vector dimension.
const MAX_DIMENSION: usize = 8192;

const OK: i32 = 0;
const INVALID_ARGUMENT: i32 = 1;

fn layout(count: usize, dimension: usize) -> Option<usize> {
    if count == 0 || count > MAX_COUNT || dimension == 0 || dimension > MAX_DIMENSION {
        return None;
    }
    count.checked_mul(dimension)
}

fn scores_len(count: usize) -> Option<usize> {
    count.checked_mul(count)
}

/// Writes the cosine score of every unordered pair into both triangles.
///
/// A zero norm yields a score of zero, matching the TypeScript behaviour of
/// leaving the score untouched when either norm is zero.
fn compute(vectors: &[f32], count: usize, dimension: usize, scores: &mut [f64]) {
    let mut norms = vec![0.0f64; count];
    for (index, norm) in norms.iter_mut().enumerate() {
        let row = &vectors[index * dimension..(index + 1) * dimension];
        let mut sum = 0.0f64;
        for value in row {
            let value = f64::from(*value);
            sum += value * value;
        }
        *norm = sum.sqrt();
    }
    for index in 0..count {
        scores[index * count + index] = 0.0;
    }
    for i in 0..count {
        let a = &vectors[i * dimension..(i + 1) * dimension];
        for j in (i + 1)..count {
            let b = &vectors[j * dimension..(j + 1) * dimension];
            let mut score = 0.0f64;
            if norms[i] != 0.0 && norms[j] != 0.0 {
                let mut dot = 0.0f64;
                for n in 0..dimension {
                    dot += f64::from(a[n]) * f64::from(b[n]);
                }
                score = dot / (norms[i] * norms[j]);
            }
            scores[i * count + j] = score;
            scores[j * count + i] = score;
        }
    }
}

/// Batch cosine scores for `count` vectors of `dimension` floats each.
///
/// # Safety
/// `vectors` must point to `count * dimension` readable floats and `scores` to
/// `count * count` writable f64 values for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn yu_graph_scores(
    vectors: *const f32,
    count: usize,
    dimension: usize,
    scores: *mut f64,
) -> i32 {
    if vectors.is_null() || scores.is_null() {
        return INVALID_ARGUMENT;
    }
    let Some(requested) = layout(count, dimension) else {
        return INVALID_ARGUMENT;
    };
    let Some(out_len) = scores_len(count) else {
        return INVALID_ARGUMENT;
    };
    let input = unsafe { std::slice::from_raw_parts(vectors, requested) };
    let output = unsafe { std::slice::from_raw_parts_mut(scores, out_len) };
    compute(input, count, dimension, output);
    OK
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIMENSION: usize = 3;

    fn scores_for(vectors: &[f32], count: usize) -> Vec<f64> {
        let mut scores = vec![0.0f64; count * count];
        compute(vectors, count, DIMENSION, &mut scores);
        scores
    }

    #[test]
    fn writes_symmetric_cosine_scores() {
        let vectors = [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let scores = scores_for(&vectors, 3);
        let at = |i: usize, j: usize| scores[i * 3 + j];
        assert!((at(0, 1) - 1.0).abs() < 1e-12);
        assert!((at(1, 0) - at(0, 1)).abs() < 1e-12);
        assert!(at(0, 2).abs() < 1e-12);
        assert_eq!(at(0, 0), 0.0);
    }

    #[test]
    fn zero_norm_scores_zero_instead_of_dividing() {
        let vectors = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0];
        let scores = scores_for(&vectors, 2);
        assert_eq!(scores[1], 0.0);
        assert_eq!(scores[2], 0.0);
    }

    #[test]
    fn keeps_f64_accumulation_order() {
        let values: Vec<f32> = (0..DIMENSION)
            .map(|index| 0.1 + index as f32 * 0.25)
            .collect();
        let mut vectors = Vec::new();
        vectors.extend_from_slice(&values);
        vectors.extend_from_slice(&values);
        let scores = scores_for(&vectors, 2);
        let mut norm = 0.0f64;
        for value in &values {
            let value = f64::from(*value);
            norm += value * value;
        }
        let mut dot = 0.0f64;
        for value in &values {
            let value = f64::from(*value);
            dot += value * value;
        }
        let expected = dot / (norm.sqrt() * norm.sqrt());
        assert_eq!(scores[1], expected);
    }

    #[test]
    fn rejects_bad_arguments_before_writing() {
        let mut output = vec![7.0f64; 4];
        let vectors = [1.0f32, 0.0];
        unsafe {
            assert_eq!(
                yu_graph_scores(std::ptr::null(), 1, 2, output.as_mut_ptr()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                yu_graph_scores(vectors.as_ptr(), 0, 2, output.as_mut_ptr()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                yu_graph_scores(vectors.as_ptr(), 1, 0, output.as_mut_ptr()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                yu_graph_scores(vectors.as_ptr(), MAX_COUNT + 1, 2, output.as_mut_ptr()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                yu_graph_scores(vectors.as_ptr(), 2, MAX_DIMENSION + 1, output.as_mut_ptr()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                yu_graph_scores(vectors.as_ptr(), 2, 2, std::ptr::null_mut()),
                INVALID_ARGUMENT
            );
        }
        assert_eq!(output, vec![7.0f64; 4]);
    }

    #[test]
    fn accepts_one_vector_and_the_node_ceiling() {
        let vectors = [1.0f32; DIMENSION];
        let mut output = [1.0f64; 1];
        unsafe {
            assert_eq!(
                yu_graph_scores(vectors.as_ptr(), 1, DIMENSION, output.as_mut_ptr()),
                OK
            )
        };
        assert_eq!(output, [0.0f64]);
        assert!(layout(MAX_COUNT, MAX_DIMENSION).is_some());
        assert!(layout(MAX_COUNT + 1, DIMENSION).is_none());
    }
}
