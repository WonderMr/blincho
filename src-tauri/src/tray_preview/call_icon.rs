use tauri::image::Image;

// A pixel-aligned handset stays legible in the existing 16px macOS template.
// Larger color icons use the same stencil, scaled with their original pixels.
const HANDSET: [&str; 8] = [
    ".##.....", "###.....", "##......", ".##.....", "..##.##.", "...#####", "....###.", "........",
];

pub(super) fn with_call_badge(original: &Image<'_>, template: bool) -> Image<'static> {
    let width = original.width();
    let height = original.height();
    let mut rgba = original.rgba().to_vec();
    let unit = (width.min(height) / 16).max(1);
    let left = width.saturating_sub(8 * unit);
    let top = height.saturating_sub(8 * unit);
    let center = (
        left as f64 + 3.5 * unit as f64,
        top as f64 + 3.5 * unit as f64,
    );
    let radius_squared = (4.5 * unit as f64).powi(2);
    for y in top.saturating_sub(unit)..height {
        for x in left.saturating_sub(unit)..width {
            let pixel = &mut rgba[((y * width + x) * 4) as usize..][..4];
            let in_badge = (x as f64 + 0.5 - center.0).powi(2)
                + (y as f64 + 0.5 - center.1).powi(2)
                <= radius_squared;
            if in_badge {
                // A transparent halo separates the handset from the mascot in
                // template mode. Color backends use a green badge and white ink.
                pixel.copy_from_slice(if template {
                    &[0, 0, 0, 0]
                } else {
                    &[18, 139, 86, 255]
                });
            }
            if x >= left && y >= top {
                let glyph_x = ((x - left) / unit) as usize;
                let glyph_y = ((y - top) / unit) as usize;
                if glyph_x < 8 && glyph_y < 8 && HANDSET[glyph_y].as_bytes()[glyph_x] == b'#' {
                    pixel.copy_from_slice(if template {
                        &[0, 0, 0, 255]
                    } else {
                        &[255, 255, 255, 255]
                    });
                }
            }
        }
    }
    Image::new_owned(rgba, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel<'a>(image: &'a Image<'_>, x: u32, y: u32) -> &'a [u8] {
        &image.rgba()[((y * image.width() + x) * 4) as usize..][..4]
    }

    #[test]
    fn template_handset_has_opaque_ink_and_clear_halo_and_preserves_identity() {
        let original =
            Image::from_bytes(include_bytes!("../../../assets/trayTemplate.png")).unwrap();
        let active = with_call_badge(&original, true);
        assert_eq!((active.width(), active.height()), (16, 16));
        assert_ne!(active.rgba(), original.rgba());
        assert_eq!(pixel(&active, 9, 8), [0, 0, 0, 255]);
        assert_eq!(pixel(&active, 12, 9), [0, 0, 0, 0]);
        for y in 0..7 {
            for x in 0..16 {
                assert_eq!(pixel(&active, x, y), pixel(&original, x, y));
            }
        }
        assert!(active
            .rgba()
            .chunks_exact(4)
            .all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0));
    }

    #[test]
    fn color_handset_scales_badge_and_keeps_original_outside_it() {
        let original = Image::new_owned(vec![30; 32 * 32 * 4], 32, 32);
        let active = with_call_badge(&original, false);
        assert_eq!((active.width(), active.height()), (32, 32));
        assert_eq!(pixel(&active, 18, 16), [255, 255, 255, 255]);
        assert_eq!(pixel(&active, 24, 18), [18, 139, 86, 255]);
        assert_eq!(pixel(&active, 4, 4), pixel(&original, 4, 4));
    }
}

// The camera occupies the upper corner; the call handset stays below it.
const CAMERA: [&str; 8] = [
    "........", ".#####..", ".#...#.#", ".#.o.###", ".#...###", ".#####.#", "........", "........",
];

pub(super) fn with_camera_badge(original: &Image<'_>) -> Image<'static> {
    let (width, height) = (original.width(), original.height());
    let mut rgba = original.rgba().to_vec();
    let unit = (width.min(height) / 16).max(1);
    let left = width.saturating_sub(8 * unit);
    let center = (left as f64 + 3.5 * unit as f64, 3.5 * unit as f64);
    for y in 0..(8 * unit).min(height) {
        for x in left.saturating_sub(unit)..width {
            let pixel = &mut rgba[((y * width + x) * 4) as usize..][..4];
            if (x as f64 + 0.5 - center.0).powi(2) + (y as f64 + 0.5 - center.1).powi(2)
                <= (4.5 * unit as f64).powi(2)
            {
                pixel.copy_from_slice(&[32, 47, 32, 255]);
            }
            if x >= left {
                let glyph = CAMERA[(y / unit) as usize].as_bytes()[((x - left) / unit) as usize];
                if glyph == b'#' {
                    pixel.copy_from_slice(&[255, 255, 255, 255]);
                }
                if glyph == b'o' {
                    pixel.copy_from_slice(&[38, 210, 38, 255]);
                }
            }
        }
    }
    Image::new_owned(rgba, width, height)
}
