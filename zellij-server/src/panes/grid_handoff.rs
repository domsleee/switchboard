//! Rebuilds a grid in a new engine. The snapshot is terminal output that, when
//! parsed by a fresh grid of the same size, leaves it in the same state.
//! Snapshots are read only by the next engine and never reach a real terminal.
#![allow(dead_code)] // Used once engines can hand a session over.
use super::{create_horizontal_tabstops, Grid, Row};
use crate::panes::terminal_character::{
    AnsiCode, CharacterStyles, CharsetIndex, Cursor, CursorShape, LinkAnchor, StandardCharset,
    RESET_STYLES,
};
use std::collections::VecDeque;
use std::fmt::Write;

const ESC: &str = "\u{1b}";
const CLOSE_LINK: &str = "\u{1b}]8;;\u{1b}\\";
/// Sets what text and cursor movement cannot: alone it marks the cursor's row
/// as continuing the line above, and with a number it sets the cursor's
/// column. A grid honours it only while restoring, so a program's output
/// cannot use it.
pub(super) const RESTORE_OSC: &[u8] = b"7719";
const MARK_WRAPPED: &str = "\u{1b}]7719\u{7}";

/// Moves the cursor without changing any row: an ordinary move pads a short
/// row with blanks, and it cannot reach the waiting-to-wrap position.
fn place(y: usize, x: usize) -> String {
    format!("{ESC}[{};1H{ESC}]7719;{x}\u{7}", y + 1)
}

impl Grid {
    /// Scrolling must be cleared first, so that `lines_below` is empty. Images,
    /// selection and scroll position are not preserved.
    pub fn handoff_snapshot(&self) -> Vec<u8> {
        let mut out = String::new();
        match &self.alternate_screen_state {
            Some(primary) => {
                self.write_screen(&primary.lines_above, &primary.viewport, &mut out);
                self.write_saved_cursor(&mut out);
                self.write_tab_stops(&mut out);
                if primary.supports_kitty_keyboard_protocol {
                    write_kitty_keyboard(&mut out);
                }
                self.write_cursor(&primary.cursor, &mut out);
                out += &format!("{ESC}[?1049h");
                // The alternate screen's text is stored already translated.
                write_default_charsets(&mut out);
                out += &format!("{ESC}[m{ESC}[H");
                self.write_rows(self.viewport.iter(), &mut out);
            },
            None => {
                self.write_screen(&self.lines_above, &self.viewport, &mut out);
                self.write_saved_cursor(&mut out);
                self.write_tab_stops(&mut out);
            },
        }
        self.write_modes(&mut out);
        self.write_titles(&mut out);
        self.write_palette(&mut out);
        self.write_cursor(&self.cursor, &mut out);
        // After the cursor, because it makes positions relative to the region.
        if self.erasure_mode {
            let _ = write!(out, "{ESC}[?6h");
        }
        if matches!(self.active_charset, CharsetIndex::G1) {
            out.push('\u{e}');
        }
        out.into_bytes()
    }

    fn write_styles(&self, tracked: &mut CharacterStyles, new: CharacterStyles, out: &mut String) {
        if let Some(changed) = tracked.update_and_return_diff(&new, None) {
            let _ = write!(out, "{changed}");
            if self.osc8_hyperlinks {
                if let Some(link) = self.link_handler.borrow().output_osc8(changed.link_anchor) {
                    out.push_str(&link);
                }
            }
        }
    }

    /// Scrollback is pushed fully off the screen first, because a viewport can
    /// hold fewer rows than the screen is tall.
    fn write_screen(&self, above: &VecDeque<Row>, viewport: &VecDeque<Row>, out: &mut String) {
        if !above.is_empty() {
            self.write_rows(above.iter(), out);
            out.push_str(&"\r\n".repeat(self.height));
            let _ = write!(out, "{ESC}[H");
        }
        self.write_rows(viewport.iter(), out);
    }

    fn write_rows<'a>(&self, rows: impl Iterator<Item = &'a Row>, out: &mut String) {
        let default = RESET_STYLES.enable_styled_underlines(self.styled_underlines);
        let mut rows = rows.peekable();
        while let Some(row) = rows.next() {
            let has_next = rows.peek().is_some();
            if !row.is_canonical {
                out.push_str(MARK_WRAPPED);
            }
            let mut tracked = default;
            let mut width = 0;
            for character in &row.columns {
                self.write_styles(&mut tracked, *character.styles, out);
                out.push(character.character);
                width += character.width();
            }
            let in_link = matches!(tracked.link_anchor, Some(LinkAnchor::Start(_)));
            if let Some(background) = row
                .bg_color
                .filter(|color| width < self.width && !matches!(color, AnsiCode::Reset))
            {
                let mut styles = default;
                styles.background = Some(background);
                let _ = write!(out, "{ESC}[m{styles}{ESC}[K");
            }
            // A background left on would colour the row a line break creates.
            let _ = write!(out, "{ESC}[m");
            if in_link && self.osc8_hyperlinks {
                out.push_str(CLOSE_LINK);
            }
            if has_next {
                out.push_str("\r\n");
            }
        }
    }

    fn write_saved_cursor(&self, out: &mut String) {
        if let Some(saved) = &self.saved_cursor_position {
            self.write_cursor(saved, out);
            let _ = write!(out, "{ESC}7");
        }
    }

    fn write_tab_stops(&self, out: &mut String) {
        if self.horizontal_tabstops == create_horizontal_tabstops(self.width) {
            return;
        }
        let _ = write!(out, "{ESC}[3g");
        // A stop past the last column can never be reached.
        for column in self.horizontal_tabstops.range(..self.width) {
            let _ = write!(out, "{}{ESC}H", place(0, *column));
        }
    }

    fn write_modes(&self, out: &mut String) {
        if self.scroll_region != (0, self.height.saturating_sub(1)) {
            let _ = write!(
                out,
                "{ESC}[{};{}r",
                self.scroll_region.0 + 1,
                self.scroll_region.1 + 1
            );
        }
        use super::{MouseMode, MouseTracking};
        let tracking = match self.mouse_tracking {
            MouseTracking::Off => None,
            MouseTracking::Normal => Some("?1000h"),
            MouseTracking::ButtonEventTracking => Some("?1002h"),
            MouseTracking::AnyEventTracking => Some("?1003h"),
        };
        let encoding = match self.mouse_mode {
            MouseMode::NoEncoding => None,
            MouseMode::Utf8 => Some("?1005h"),
            MouseMode::Sgr => Some("?1006h"),
        };
        for code in [tracking, encoding].into_iter().flatten() {
            let _ = write!(out, "{ESC}[{code}");
        }
        for (enabled, code) in [
            (self.cursor_key_mode, "?1h"),
            (self.disable_linewrap, "?7l"),
            (self.sixel_scrolling, "?80h"),
            (self.focus_event_tracking, "?1004h"),
            (self.bracketed_paste_mode, "?2004h"),
            (self.lock_renders, "?2026h"),
            (self.color_palette_notification_enabled, "?2031h"),
            (self.cursor_is_hidden, "?25l"),
            (self.insert_mode, "4h"),
            (self.new_line_mode, "20h"),
        ] {
            if enabled {
                let _ = write!(out, "{ESC}[{code}");
            }
        }
        if self.supports_kitty_keyboard_protocol {
            write_kitty_keyboard(out);
        }
    }

    fn write_titles(&self, out: &mut String) {
        for title in &self.title_stack {
            let _ = write!(out, "{ESC}]2;{title}\u{7}{ESC}[22t");
        }
        if let Some(title) = &self.title {
            let _ = write!(out, "{ESC}]2;{title}\u{7}");
        }
    }

    fn write_palette(&self, out: &mut String) {
        let Some(colors) = &self.changed_colors else {
            return;
        };
        for (index, color) in colors.iter().enumerate() {
            if let Some(AnsiCode::RgbCode((r, g, b))) = color {
                let _ = write!(out, "{ESC}]4;{index};rgb:{r:02x}/{g:02x}/{b:02x}\u{7}");
            }
        }
    }

    /// Position, character sets, shape and the style of the next character.
    fn write_cursor(&self, cursor: &Cursor, out: &mut String) {
        self.write_position(cursor, out);
        write_charsets(cursor, out);
        let shape = match cursor.get_shape() {
            CursorShape::Initial => 0,
            CursorShape::BlinkingBlock => 1,
            CursorShape::Block => 2,
            CursorShape::BlinkingUnderline => 3,
            CursorShape::Underline => 4,
            CursorShape::BlinkingBeam => 5,
            CursorShape::Beam => 6,
        };
        if shape != 0 {
            let _ = write!(out, "{ESC}[{shape} q");
        }
        let _ = write!(out, "{ESC}[m{}", *cursor.pending_styles);
        if self.osc8_hyperlinks {
            match self
                .link_handler
                .borrow()
                .output_osc8(cursor.pending_styles.link_anchor)
            {
                Some(link) => out.push_str(&link),
                None => out.push_str(CLOSE_LINK),
            }
        }
    }

    fn write_position(&self, cursor: &Cursor, out: &mut String) {
        out.push_str(&place(cursor.y, cursor.x));
    }
}

fn write_kitty_keyboard(out: &mut String) {
    let _ = write!(out, "{ESC}[=1u");
}

fn write_default_charsets(out: &mut String) {
    let _ = write!(out, "{ESC}(B{ESC})B{ESC}*B{ESC}+B\u{f}");
}

fn write_charsets(cursor: &Cursor, out: &mut String) {
    for (index, designator) in [
        (CharsetIndex::G0, '('),
        (CharsetIndex::G1, ')'),
        (CharsetIndex::G2, '*'),
        (CharsetIndex::G3, '+'),
    ] {
        let code = match cursor.charsets[index] {
            StandardCharset::Ascii => 'B',
            StandardCharset::UK => 'A',
            StandardCharset::SpecialCharacterAndLineDrawing => '0',
        };
        let _ = write!(out, "{ESC}{designator}{code}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panes::kitty_graphics::KittyImageStore;
    use crate::panes::link_handler::LinkHandler;
    use crate::panes::sixel::SixelImageStore;
    use crate::terminal_host::SequenceTracker;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;
    use zellij_utils::data::{Palette, Style};

    fn grid(rows: usize, columns: usize) -> Grid {
        Grid::new(
            rows,
            columns,
            Rc::new(RefCell::new(Palette::default())),
            Rc::new(RefCell::new(HashMap::new())),
            Rc::new(RefCell::new(LinkHandler::new())),
            Rc::new(RefCell::new(None)),
            Rc::new(RefCell::new(SixelImageStore::default())),
            Rc::new(RefCell::new(KittyImageStore::default())),
            Style::default(),
            false,
            true,
            true,
            true,
            false,
        )
    }

    fn link_target(grid: &Grid, styles: &CharacterStyles) -> String {
        match styles.link_anchor {
            Some(LinkAnchor::Start(_)) => {
                let osc = grid
                    .link_handler
                    .borrow()
                    .output_osc8(styles.link_anchor)
                    .unwrap_or_default();
                // Link ids are renumbered; the target is what must survive.
                osc.split_once("]8;")
                    .and_then(|(_, rest)| rest.split_once(';'))
                    .map_or(osc.clone(), |(_, target)| target.to_string())
            },
            _ => String::new(),
        }
    }

    fn style_key(grid: &Grid, styles: &CharacterStyles) -> String {
        let mut plain = styles.enable_styled_underlines(false);
        plain.link_anchor = None;
        format!("{plain:?}{}", link_target(grid, styles))
    }

    fn row_key(grid: &Grid, row: &Row) -> String {
        let blank = style_key(grid, &EMPTY_STYLES);
        let mut cells: Vec<(char, String)> = row
            .columns
            .iter()
            .map(|c| (c.character, style_key(grid, &c.styles)))
            .collect();
        while cells
            .last()
            .is_some_and(|(character, style)| *character == ' ' && *style == blank)
        {
            cells.pop();
        }
        let background = row
            .bg_color
            .filter(|color| !matches!(color, AnsiCode::Reset));
        if cells.is_empty() && background.is_none() {
            return "|[]".to_string();
        }
        format!("{}|{background:?}{cells:?}", row.is_canonical)
    }

    const EMPTY_STYLES: CharacterStyles = RESET_STYLES;

    fn rows_key(
        grid: &Grid,
        rows: impl Iterator<Item = impl std::borrow::Borrow<Row>>,
    ) -> Vec<String> {
        let mut keys: Vec<String> = rows.map(|row| row_key(grid, row.borrow())).collect();
        while keys.last().is_some_and(|key| key.ends_with("|[]")) {
            keys.pop();
        }
        keys
    }

    fn cursor_key(grid: &Grid, cursor: &Cursor) -> String {
        format!(
            "{},{} {} {:?} {:?}",
            cursor.x,
            cursor.y,
            style_key(grid, &cursor.pending_styles),
            cursor.get_shape(),
            [
                cursor.charsets[CharsetIndex::G0],
                cursor.charsets[CharsetIndex::G1],
                cursor.charsets[CharsetIndex::G2],
                cursor.charsets[CharsetIndex::G3],
            ],
        )
    }

    fn state(grid: &Grid) -> Vec<String> {
        let mut out = vec![format!(
            "scrollback {:?}",
            rows_key(grid, grid.lines_above.iter())
        )];
        out.push(format!(
            "viewport {:?}",
            rows_key(grid, grid.viewport.iter())
        ));
        if let Some(primary) = &grid.alternate_screen_state {
            out.push(format!(
                "primary scrollback {:?}",
                rows_key(grid, primary.lines_above.iter())
            ));
            out.push(format!(
                "primary viewport {:?}",
                rows_key(grid, primary.viewport.iter())
            ));
            out.push(format!(
                "primary cursor {}",
                cursor_key(grid, &primary.cursor)
            ));
            out.push(format!(
                "primary kitty {}",
                primary.supports_kitty_keyboard_protocol
            ));
        }
        out.push(format!("cursor {}", cursor_key(grid, &grid.cursor)));
        out.push(format!(
            "saved {:?}",
            grid.saved_cursor_position
                .as_ref()
                .map(|cursor| cursor_key(grid, cursor))
        ));
        out.push(format!(
            "tabs {:?}",
            grid.horizontal_tabstops
                .range(..grid.width)
                .collect::<Vec<_>>()
        ));
        out.push(format!("active charset {:?}", grid.active_charset));
        out.push(format!(
            "modes hidden={} region={:?} ckm={} erm={} nowrap={} sdm={} focus={} paste={} sync={} palette={} insert={} lnm={} mouse={:?}/{:?} kitty={}",
            grid.cursor_is_hidden,
            grid.scroll_region,
            grid.cursor_key_mode,
            grid.erasure_mode,
            grid.disable_linewrap,
            grid.sixel_scrolling,
            grid.focus_event_tracking,
            grid.bracketed_paste_mode,
            grid.lock_renders,
            grid.color_palette_notification_enabled,
            grid.insert_mode,
            grid.new_line_mode,
            grid.mouse_mode,
            grid.mouse_tracking,
            grid.supports_kitty_keyboard_protocol,
        ));
        out.push(format!(
            "title {:?} stack {:?}",
            grid.title, grid.title_stack
        ));
        out.push(format!(
            "palette {:?}",
            grid.changed_colors.map(|colors| colors
                .iter()
                .enumerate()
                .filter_map(|(index, color)| color.map(|color| format!("{index}={color:?}")))
                .collect::<Vec<_>>())
        ));
        out
    }

    fn differing_rows(restored: &Grid, original: &Grid) -> String {
        let describe = |grid: &Grid, row: Option<&Row>| match row {
            None => "<no row>".to_string(),
            Some(row) => format!(
                "canonical={} cells={} text={:?} last={:?}",
                row.is_canonical,
                row.columns.len(),
                row.columns.iter().map(|c| c.character).collect::<String>(),
                row.columns.back().map(|c| style_key(grid, &c.styles)),
            ),
        };
        let mut out = String::new();
        let rows = restored.viewport.len().max(original.viewport.len());
        for index in 0..rows {
            let (a, b) = (restored.viewport.get(index), original.viewport.get(index));
            let same = match (a, b) {
                (Some(a), Some(b)) => row_key(restored, a) == row_key(original, b),
                _ => false,
            };
            if !same {
                out += &format!(
                    "\n row {index}\n  restored {}\n  original {}",
                    describe(restored, a),
                    describe(original, b)
                );
            }
        }
        out
    }

    fn first_difference(restored: &[String], original: &[String]) -> Option<String> {
        restored
            .iter()
            .zip(original)
            .find(|(a, b)| a != b)
            .map(|(a, b)| {
                let at = a
                    .chars()
                    .zip(b.chars())
                    .position(|(x, y)| x != y)
                    .unwrap_or(a.chars().count().min(b.chars().count()));
                let around = |text: &str| {
                    text.chars()
                        .skip(at.saturating_sub(60))
                        .take(240)
                        .collect::<String>()
                };
                format!("\n restored: {}\n original: {}", around(a), around(b))
            })
    }

    fn restore(original: &Grid, rows: usize, columns: usize) -> Grid {
        let mut restored = grid(rows, columns);
        restored.set_restoring_handoff(true);
        vte::Parser::new().advance(&mut restored, &original.handoff_snapshot());
        restored.set_restoring_handoff(false);
        restored
    }

    #[test]
    fn a_program_cannot_mark_a_row_wrapped() {
        let mut grid = grid(5, 20);
        vte::Parser::new().advance(&mut grid, b"one\r\n\x1b]7719\x07two");
        assert!(grid.viewport[1].is_canonical);
    }

    #[test]
    fn a_wrapped_row_after_a_short_row_stays_wrapped() {
        // Erasing leaves the first row short and the second still wrapped.
        assert_restores(b"12345678901234567890abc\x1b[1;5H\x1b[K", 5, 20);
    }

    fn assert_restores(bytes: &[u8], rows: usize, columns: usize) {
        let mut original = grid(rows, columns);
        vte::Parser::new().advance(&mut original, bytes);
        let restored = restore(&original, rows, columns);
        assert_eq!(
            first_difference(&state(&restored), &state(&original)),
            None,
            "for input {:?}",
            String::from_utf8_lossy(bytes)
        );
    }

    #[test]
    fn plain_and_styled_text() {
        assert_restores(
            b"hello\r\n\x1b[31mred\x1b[0m plain\r\n\x1b[1;44mbold on blue",
            5,
            40,
        );
    }

    #[test]
    fn a_screen_that_is_not_full_starts_at_the_top() {
        assert_restores(b"first\r\nsecond", 24, 80);
    }

    #[test]
    fn scrollback_and_wrapped_lines() {
        let mut bytes = Vec::new();
        for line in 0..40 {
            bytes.extend_from_slice(format!("line {line} {}\r\n", "x".repeat(25)).as_bytes());
        }
        assert_restores(&bytes, 5, 20);
    }

    #[test]
    fn hyperlinks() {
        assert_restores(
            b"a \x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\ b",
            5,
            40,
        );
    }

    #[test]
    fn a_hyperlink_still_open_applies_to_later_text() {
        assert_restores(b"\x1b]8;;http://example.com\x1b\\open", 5, 40);
    }

    #[test]
    fn alternate_screen_and_the_screen_behind_it() {
        assert_restores(
            b"behind\r\n\x1b[32mgreen\x1b[0m\x1b[?1049h\x1b[Halt text\x1b[3;4H\x1b[35mX",
            10,
            40,
        );
    }

    #[test]
    fn scroll_region_modes_and_cursor() {
        assert_restores(
            b"text\x1b[2;4r\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b[4h\x1b[?7l\x1b[=1u\x1b[3 q\x1b[3;2H",
            10,
            40,
        );
    }

    #[test]
    fn saved_cursor_character_sets_and_tab_stops() {
        assert_restores(
            b"\x1b[3;3H\x1b[33m\x1b7\x1b[m\x1b(0q\x1b(B\x1b)0\x0e\x1b[3g\x1b[1;5H\x1bH\x1b[5;1H",
            10,
            40,
        );
    }

    #[test]
    fn a_cursor_waiting_to_wrap() {
        assert_restores(b"12345678901234567890", 5, 20);
        assert_restores(b"\x1b[31m1234567890123456789\x1b[32mX\x1b[35m", 5, 20);
    }

    #[test]
    fn wide_characters() {
        assert_restores(
            "a\u{65e5}\u{672c}b\r\n\u{65e5}\u{672c}\u{8a9e}\u{65e5}\u{672c}".as_bytes(),
            5,
            8,
        );
    }

    #[test]
    fn titles_and_colours() {
        assert_restores(
            b"\x1b]2;one\x07\x1b[22t\x1b]2;two\x07\x1b]4;3;rgb:11/22/33\x07x",
            5,
            40,
        );
    }

    #[test]
    fn a_background_erase_keeps_the_rows_colour() {
        assert_restores(b"\x1b[44m\x1b[Kabc\x1b[K\r\n\x1b[41m\x1b[2K", 5, 40);
    }

    /// Stops a recorded program at several points and continues it on a rebuilt
    /// grid. Screens are compared when stopped and after the rest of the output.
    fn fixture_survives_handoff(
        path: &std::path::Path,
        rows: usize,
        columns: usize,
    ) -> Result<(), String> {
        let bytes = std::fs::read(path).unwrap();
        for cut in 1..=7 {
            let stop = bytes.len() * cut / 7;
            let mut tracker = SequenceTracker::new(0);
            tracker.advance(&bytes[..stop]);
            let Some(resume) = tracker.resume_position() else {
                continue;
            };
            let mut original = grid(rows, columns);
            let mut parser = vte::Parser::new();
            parser.advance(&mut original, &bytes[..stop]);
            let mut restored = restore(&original, rows, columns);
            if let Some(difference) = first_difference(&state(&restored), &state(&original)) {
                return Err(format!(
                    "stopped at {stop}/{}:{}{difference}",
                    bytes.len(),
                    differing_rows(&restored, &original)
                ));
            }
            parser.advance(&mut original, &bytes[stop..]);
            vte::Parser::new().advance(&mut restored, &bytes[resume as usize..]);
            if let Some(difference) = first_difference(&state(&restored), &state(&original)) {
                return Err(format!(
                    "continued from {stop}/{}:{}{difference}",
                    bytes.len(),
                    differing_rows(&restored, &original)
                ));
            }
        }
        Ok(())
    }

    #[test]
    fn recorded_programs_survive_a_handoff() {
        let mut failures = Vec::new();
        let mut checked = 0;
        for entry in std::fs::read_dir("../src/tests/fixtures").unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            // Images are not preserved, and the rest are not terminal output.
            if !path.is_file()
                || name.ends_with(".six")
                || name.ends_with(".kdl")
                || name.ends_with(".sh")
            {
                continue;
            }
            for (rows, columns) in [(41, 110), (20, 60)] {
                checked += 1;
                if let Err(error) = fixture_survives_handoff(&path, rows, columns) {
                    failures.push(format!("{name} at {columns}x{rows}: {error}"));
                }
            }
        }
        assert!(checked > 100, "only {checked} recordings checked");
        assert!(
            failures.is_empty(),
            "{} of {checked} failed:\n{}",
            failures.len(),
            failures
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
