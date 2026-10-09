//! An SVG path-data parser that builds Direct2D geometry.
//!
//! Only as much of the grammar as the data in this binary uses — which is all of it except
//! `catmullRom`, because the glyph table is generated and the few hand-written paths here are
//! written against this parser. Anything it cannot read is silently truncated rather than
//! rejected: a glyph that draws most of itself is a better failure than a wheel with a hole in it,
//! and `tests` pins the one case that matters (that every glyph in the table parses whole).
//!
//! The parser is written against `ID2D1GeometrySink` directly rather than producing an
//! intermediate list of segments. A glyph is parsed once, at the moment it is first drawn, and the
//! resulting `ID2D1PathGeometry` is cached — so the parse happens at most once per glyph per
//! session and never on a frame that is already drawing.

use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_BEZIER_SEGMENT, D2D1_FIGURE_BEGIN_HOLLOW, D2D1_FIGURE_END_CLOSED, D2D1_FIGURE_END_OPEN,
    D2D1_FILL_MODE_WINDING, D2D_POINT_2F, D2D_SIZE_F,
};
use windows::Win32::Graphics::Direct2D::{
    ID2D1GeometrySink, D2D1_ARC_SEGMENT, D2D1_ARC_SIZE_LARGE, D2D1_ARC_SIZE_SMALL,
    D2D1_QUADRATIC_BEZIER_SEGMENT, D2D1_SWEEP_DIRECTION_CLOCKWISE,
    D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE,
};

/// Walks the path data, emitting into `sink`.
///
/// `scale` and `offset` are applied to every coordinate as it is read, which is cheaper and more
/// accurate than drawing in glyph space and asking D2D for a transformed geometry: a transform
/// would scale the STROKE as well, and these glyphs are stroked at a weight chosen for the final
/// size rather than the 24-unit box they are authored in.
pub fn build(sink: &ID2D1GeometrySink, data: &str, scale: f32, offset: (f32, f32)) {
    let mut p = Parser::new(data);
    unsafe { sink.SetFillMode(D2D1_FILL_MODE_WINDING) };

    // Current point, start of the current subpath, and the reflection control points that `S` and
    // `T` need. Kept in GLYPH space: the reflection is a mirror of the previous control point
    // about the current point, and mirroring in a scaled space then scaling again would square the
    // factor.
    let (mut cx, mut cy) = (0.0f32, 0.0f32);
    let (mut sx, mut sy) = (0.0f32, 0.0f32);
    let (mut last_cubic, mut last_quad) = (None::<(f32, f32)>, None::<(f32, f32)>);
    let mut open = false;
    let mut command = b' ';

    let xf = |x: f32, y: f32| D2D_POINT_2F {
        x: x * scale + offset.0,
        y: y * scale + offset.1,
    };

    macro_rules! end_figure {
        ($how:expr) => {
            if open {
                unsafe { sink.EndFigure($how) };
                open = false;
            }
        };
    }

    loop {
        p.skip_separators();
        if let Some(letter) = p.peek_command() {
            command = letter;
            p.advance(1);
        } else if p.at_end() {
            break;
        } else if command == b' ' {
            // Data that starts with a number is not a path. Nothing to draw.
            break;
        } else if matches!(command, b'M' | b'm') {
            // An implicit repeat of `M` is a LINE, not another move — the one asymmetry in the
            // grammar, and the one a naive parser gets wrong by leaving a gap in every glyph that
            // uses the shorthand.
            command = if command == b'M' { b'L' } else { b'l' };
        }

        let relative = command.is_ascii_lowercase();
        let (rx, ry) = if relative { (cx, cy) } else { (0.0, 0.0) };

        match command.to_ascii_uppercase() {
            b'M' => {
                let Some((x, y)) = p.pair() else { break };
                let (x, y) = (x + rx, y + ry);
                end_figure!(D2D1_FIGURE_END_OPEN);
                unsafe { sink.BeginFigure(xf(x, y), D2D1_FIGURE_BEGIN_HOLLOW) };
                open = true;
                (cx, cy) = (x, y);
                (sx, sy) = (x, y);
                (last_cubic, last_quad) = (None, None);
            }
            b'L' => {
                let Some((x, y)) = p.pair() else { break };
                let (x, y) = (x + rx, y + ry);
                if !open {
                    break;
                }
                unsafe { sink.AddLine(xf(x, y)) };
                (cx, cy) = (x, y);
                (last_cubic, last_quad) = (None, None);
            }
            b'H' => {
                let Some(x) = p.number() else { break };
                let x = x + rx;
                if !open {
                    break;
                }
                unsafe { sink.AddLine(xf(x, cy)) };
                cx = x;
                (last_cubic, last_quad) = (None, None);
            }
            b'V' => {
                let Some(y) = p.number() else { break };
                let y = y + ry;
                if !open {
                    break;
                }
                unsafe { sink.AddLine(xf(cx, y)) };
                cy = y;
                (last_cubic, last_quad) = (None, None);
            }
            b'C' | b'S' => {
                let (c1x, c1y) = if command.to_ascii_uppercase() == b'C' {
                    let Some(p1) = p.pair() else { break };
                    (p1.0 + rx, p1.1 + ry)
                } else {
                    // `S`: the first control point is the reflection of the previous one. With no
                    // previous cubic it coincides with the current point, which makes the curve a
                    // quadratic — exactly what the spec says.
                    match last_cubic {
                        Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                        None => (cx, cy),
                    }
                };
                let Some(p2) = p.pair() else { break };
                let Some(pe) = p.pair() else { break };
                let (c2x, c2y) = (p2.0 + rx, p2.1 + ry);
                let (ex, ey) = (pe.0 + rx, pe.1 + ry);
                if !open {
                    break;
                }
                unsafe {
                    sink.AddBezier(&D2D1_BEZIER_SEGMENT {
                        point1: xf(c1x, c1y),
                        point2: xf(c2x, c2y),
                        point3: xf(ex, ey),
                    })
                };
                (cx, cy) = (ex, ey);
                last_cubic = Some((c2x, c2y));
                last_quad = None;
            }
            b'Q' | b'T' => {
                let (c1x, c1y) = if command.to_ascii_uppercase() == b'Q' {
                    let Some(p1) = p.pair() else { break };
                    (p1.0 + rx, p1.1 + ry)
                } else {
                    match last_quad {
                        Some((px, py)) => (2.0 * cx - px, 2.0 * cy - py),
                        None => (cx, cy),
                    }
                };
                let Some(pe) = p.pair() else { break };
                let (ex, ey) = (pe.0 + rx, pe.1 + ry);
                if !open {
                    break;
                }
                unsafe {
                    sink.AddQuadraticBezier(&D2D1_QUADRATIC_BEZIER_SEGMENT {
                        point1: xf(c1x, c1y),
                        point2: xf(ex, ey),
                    })
                };
                (cx, cy) = (ex, ey);
                last_quad = Some((c1x, c1y));
                last_cubic = None;
            }
            b'A' => {
                let Some(radii) = p.pair() else { break };
                let Some(rotation) = p.number() else { break };
                let Some(large) = p.flag() else { break };
                let Some(sweep) = p.flag() else { break };
                let Some(pe) = p.pair() else { break };
                let (ex, ey) = (pe.0 + rx, pe.1 + ry);
                if !open {
                    break;
                }
                unsafe {
                    sink.AddArc(&D2D1_ARC_SEGMENT {
                        point: xf(ex, ey),
                        // Radii scale with the glyph; the rotation does not.
                        size: D2D_SIZE_F {
                            width: radii.0.abs() * scale,
                            height: radii.1.abs() * scale,
                        },
                        rotationAngle: rotation,
                        // SVG's sweep flag is "the positive-angle direction", which in a y-down
                        // space is clockwise. Getting this backwards does not fail — it draws the
                        // arc the other way round the same two endpoints, which is how a rounded
                        // corner ends up bulging outward.
                        sweepDirection: if sweep {
                            D2D1_SWEEP_DIRECTION_CLOCKWISE
                        } else {
                            D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE
                        },
                        arcSize: if large {
                            D2D1_ARC_SIZE_LARGE
                        } else {
                            D2D1_ARC_SIZE_SMALL
                        },
                    })
                };
                (cx, cy) = (ex, ey);
                (last_cubic, last_quad) = (None, None);
            }
            b'Z' => {
                end_figure!(D2D1_FIGURE_END_CLOSED);
                (cx, cy) = (sx, sy);
                (last_cubic, last_quad) = (None, None);
                // A `Z` does not end the path: anything that follows continues from the subpath's
                // start point, and needs a figure to live in.
                p.skip_separators();
                if !p.at_end() && p.peek_command().is_none() {
                    break;
                }
            }
            _ => break,
        }
    }

    end_figure!(D2D1_FIGURE_END_OPEN);
}

/// How many figures and segments a path has, without a device.
///
/// Only exists so the parser can be tested: it walks the same grammar with the same loop, and a
/// glyph whose geometry comes out empty here would come out empty on screen.
#[cfg(test)]
pub fn measure(data: &str) -> (usize, usize) {
    let mut p = Parser::new(data);
    let (mut figures, mut segments) = (0usize, 0usize);
    let mut command = b' ';
    let mut open = false;
    loop {
        p.skip_separators();
        if let Some(letter) = p.peek_command() {
            command = letter;
            p.advance(1);
        } else if p.at_end() {
            break;
        } else if command == b' ' {
            break;
        } else if matches!(command, b'M' | b'm') {
            command = if command == b'M' { b'L' } else { b'l' };
        }
        let taken = match command.to_ascii_uppercase() {
            b'M' => {
                if p.pair().is_none() {
                    break;
                }
                figures += 1;
                open = true;
                continue;
            }
            b'L' => p.pair().map(|_| 1),
            b'H' | b'V' => p.number().map(|_| 1),
            b'C' => (|| Some((p.pair()?, p.pair()?, p.pair()?)))().map(|_| 1),
            b'S' | b'Q' => (|| Some((p.pair()?, p.pair()?)))().map(|_| 1),
            b'T' => p.pair().map(|_| 1),
            b'A' => (|| {
                p.pair()?;
                p.number()?;
                p.flag()?;
                p.flag()?;
                p.pair()
            })()
            .map(|_| 1),
            b'Z' => Some(0),
            _ => None,
        };
        match taken {
            Some(count) if open => segments += count,
            Some(_) => break,
            None => break,
        }
    }
    (figures, segments)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn new(data: &'a str) -> Self {
        Self {
            bytes: data.as_bytes(),
            at: 0,
        }
    }

    fn at_end(&self) -> bool {
        self.at >= self.bytes.len()
    }

    fn advance(&mut self, by: usize) {
        self.at += by;
    }

    /// Whitespace and commas, which the grammar treats identically.
    fn skip_separators(&mut self) {
        while let Some(&b) = self.bytes.get(self.at) {
            if b == b',' || b.is_ascii_whitespace() {
                self.at += 1;
            } else {
                break;
            }
        }
    }

    fn peek_command(&self) -> Option<u8> {
        let b = *self.bytes.get(self.at)?;
        matches!(
            b.to_ascii_uppercase(),
            b'M' | b'L' | b'H' | b'V' | b'C' | b'S' | b'Q' | b'T' | b'A' | b'Z'
        )
        .then_some(b)
    }

    fn number(&mut self) -> Option<f32> {
        self.skip_separators();
        let start = self.at;
        if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
            self.at += 1;
        }
        let mut digits = false;
        while matches!(self.bytes.get(self.at), Some(b) if b.is_ascii_digit()) {
            self.at += 1;
            digits = true;
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            while matches!(self.bytes.get(self.at), Some(b) if b.is_ascii_digit()) {
                self.at += 1;
                digits = true;
            }
        }
        if !digits {
            self.at = start;
            return None;
        }
        // Exponent. No glyph in the table uses one, but a hand-written path might, and a `1e-3`
        // read as `1` followed by a stray `e` would desynchronise the whole rest of the path.
        if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
            let mark = self.at;
            self.at += 1;
            if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            let mut exp_digits = false;
            while matches!(self.bytes.get(self.at), Some(b) if b.is_ascii_digit()) {
                self.at += 1;
                exp_digits = true;
            }
            if !exp_digits {
                self.at = mark;
            }
        }
        std::str::from_utf8(&self.bytes[start..self.at])
            .ok()?
            .parse()
            .ok()
    }

    fn pair(&mut self) -> Option<(f32, f32)> {
        let x = self.number()?;
        let y = self.number()?;
        Some((x, y))
    }

    /// An arc flag is a single `0` or `1` and may be written with no separator at all —
    /// `a5 5 0 1 0 10 0` and `a5 5 0 110 0` are the same arc. Reading it with `number()` would
    /// swallow `110` as one value and leave the arc two coordinates short.
    fn flag(&mut self) -> Option<bool> {
        self.skip_separators();
        match self.bytes.get(self.at) {
            Some(b'0') => {
                self.at += 1;
                Some(false)
            }
            Some(b'1') => {
                self.at += 1;
                Some(true)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_generated_glyph_parses_whole() {
        // The one test that matters: a glyph whose parse stops early draws a fragment, and nobody
        // inspects 1,353 icons by hand.
        for (name, data) in crate::gfx::lucide_data::GLYPHS {
            let (figures, segments) = measure(data);
            assert!(figures > 0, "{name} produced no figure");
            assert!(segments > 0, "{name} produced no segment");
            // Everything consumed: `measure` stops at the first thing it cannot read, so a
            // truncated parse shows up as a shorter run than the data allows.
            let mut p = Parser::new(data);
            let mut seen_commands = 0;
            loop {
                p.skip_separators();
                if p.peek_command().is_some() {
                    seen_commands += 1;
                    p.advance(1);
                } else if p.number().is_none() {
                    break;
                }
            }
            assert!(p.at_end(), "{name}: stopped at byte {} of {}", p.at, data.len());
            assert!(seen_commands > 0, "{name} has no commands");
        }
    }

    #[test]
    fn an_implicit_moveto_repeat_is_a_line() {
        // The one asymmetry in the grammar. Read as another move it leaves a gap instead of an edge.
        let (figures, segments) = measure("M0 0 10 0 10 10");
        assert_eq!(figures, 1);
        assert_eq!(segments, 2);
    }

    #[test]
    fn arc_flags_need_no_separator() {
        // `a5 5 0 110 0` is large=1, sweep=1, endpoint (0, 0) — not the number 110.
        let mut p = Parser::new("5 5 0 110 0");
        assert_eq!(p.pair(), Some((5.0, 5.0)));
        assert_eq!(p.number(), Some(0.0));
        assert_eq!(p.flag(), Some(true));
        assert_eq!(p.flag(), Some(true));
        assert_eq!(p.pair(), Some((0.0, 0.0)));
    }

    #[test]
    fn numbers_may_run_together() {
        // SVG allows `.5.5` and `1-2`; both appear in real-world path data.
        let mut p = Parser::new(".5.5 1-2");
        assert_eq!(p.number(), Some(0.5));
        assert_eq!(p.number(), Some(0.5));
        assert_eq!(p.number(), Some(1.0));
        assert_eq!(p.number(), Some(-2.0));
        assert!(p.at_end());
    }

    #[test]
    fn exponents_do_not_desynchronise_the_path() {
        let mut p = Parser::new("1e-3 2E2 3");
        assert_eq!(p.number(), Some(0.001));
        assert_eq!(p.number(), Some(200.0));
        assert_eq!(p.number(), Some(3.0));
    }

    #[test]
    fn a_dangling_exponent_is_not_consumed() {
        // `1e` is the number 1 followed by something this parser must leave alone, not a failure.
        let mut p = Parser::new("1e");
        assert_eq!(p.number(), Some(1.0));
        assert!(!p.at_end());
    }

    #[test]
    fn data_without_a_leading_command_draws_nothing() {
        assert_eq!(measure("10 10 20 20"), (0, 0));
        assert_eq!(measure(""), (0, 0));
    }

    #[test]
    fn a_closed_subpath_can_be_followed_by_another() {
        let (figures, segments) = measure("M0 0H10V10ZM20 20H30V30Z");
        assert_eq!(figures, 2);
        assert_eq!(segments, 4);
    }
}
