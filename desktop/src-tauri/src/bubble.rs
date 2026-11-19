// ADR-0041 — the recording bubble: a small always-on-top window with the Loro
// icon that the person drags anywhere, and that grows into a panel on click.
//
// What lives here is the WINDOW's half: where it sits (persisted per screen in
// ~/.loro/config.json), how it grows into the panel without leaving the screen,
// and the macOS window behavior that keeps it over every Space and over
// fullscreen apps. What it SHOWS and what its buttons DO live in the frontend
// (`src/bubble.html`, driven by the main window's `app.js`, which owns the
// meeting) — this module never decides anything about a recording.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

use crate::config::{read_loro_config, write_loro_config};

pub const LABEL: &str = "bubble";
/// The icon sizes the person can pick (owner, 2026-11-18: «1/4 do tamanho» —
/// a quarter of the AREA of the 64 pt icon is 32 pt, the default).
pub const SIZES: [u32; 3] = [32, 48, 64];
pub const DEFAULT_SIZE: u32 = 32;
/// Room around the icon inside the collapsed window: its shadow and the
/// recording badge that sits on its corner.
const ICON_PAD: f64 = 6.0;

/// The size a stored value means: anything that is not one of SIZES reads as
/// the default, never as an icon too small to grab or too big to ignore.
pub fn normalize_size(px: u32) -> u32 {
    if SIZES.contains(&px) {
        px
    } else {
        DEFAULT_SIZE
    }
}

/// The collapsed window for an icon size.
pub fn collapsed_for(size: u32) -> (f64, f64) {
    let s = normalize_size(size) as f64 + 2.0 * ICON_PAD;
    (s, s)
}
/// The panel the bubble grows into.
pub const EXPANDED: (f64, f64) = (340.0, 520.0);
/// The distance kept from the edge of the screen when the bubble is placed there.
const MARGIN: f64 = 16.0;

/// `"balao": { "visivel": true, "posicoes": { "<screen>": { "fx": .., "fy": .. } } }`.
/// Absent = visible at the default spot: the bubble is the recording control, so
/// it is shown unless the person hid it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BubbleCfg {
    #[serde(default = "yes")]
    pub visivel: bool,
    // the screen it was last left on: one spot PER screen is kept (dragging it
    // to the external monitor does not forget where it sat on the laptop's)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tela: Option<String>,
    #[serde(default)]
    pub posicoes: BTreeMap<String, Spot>,
    // the icon size in pt: 32 (pequeno), 48 (médio) or 64 (grande)
    #[serde(default = "default_size")]
    pub tamanho: u32,
    // owner, 2026-11-19: "ocultar quando a janela do loro for aberta" — while
    // the main window is in front, the bubble steps aside (not persisted as
    // hidden: it comes back as soon as the window loses focus)
    #[serde(default = "yes")]
    pub ocultar_com_janela: bool,
}

fn yes() -> bool {
    true
}
fn default_size() -> u32 {
    DEFAULT_SIZE
}

impl Default for BubbleCfg {
    fn default() -> Self {
        Self {
            visivel: true,
            tela: None,
            posicoes: BTreeMap::new(),
            tamanho: DEFAULT_SIZE,
            ocultar_com_janela: true,
        }
    }
}

/// Where the bubble sits on one screen, as a FRACTION of the room it can move
/// in (0 = left/top edge, 1 = right/bottom edge). A fraction, not pixels: the
/// same screen at another resolution, or the Dock moving, keeps the bubble in
/// the same corner instead of throwing it off the visible area.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub fx: f64,
    pub fy: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn right(&self) -> f64 {
        self.x + self.w
    }
    fn bottom(&self) -> f64 {
        self.y + self.h
    }
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

/// Which corner of the panel the icon is in — the panel grows AWAY from it,
/// toward the side of the screen with more room.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub right: bool,
    pub bottom: bool,
}

// ---- pure geometry ----------------------------------------------------------

/// Keeps a window of `size` inside `area`. A window larger than the area is
/// pinned to its top-left: the controls are there.
pub fn clamp_origin(x: f64, y: f64, size: (f64, f64), area: Rect) -> (f64, f64) {
    let max_x = (area.right() - size.0).max(area.x);
    let max_y = (area.bottom() - size.1).max(area.y);
    (x.clamp(area.x, max_x), y.clamp(area.y, max_y))
}

pub fn spot_of(x: f64, y: f64, size: (f64, f64), area: Rect) -> Spot {
    let room_x = (area.w - size.0).max(1.0);
    let room_y = (area.h - size.1).max(1.0);
    Spot {
        fx: ((x - area.x) / room_x).clamp(0.0, 1.0),
        fy: ((y - area.y) / room_y).clamp(0.0, 1.0),
    }
}

pub fn origin_of(spot: Spot, size: (f64, f64), area: Rect) -> (f64, f64) {
    let fx = if spot.fx.is_finite() {
        spot.fx.clamp(0.0, 1.0)
    } else {
        1.0
    };
    let fy = if spot.fy.is_finite() {
        spot.fy.clamp(0.0, 1.0)
    } else {
        0.7
    };
    let x = area.x + fx * (area.w - size.0).max(0.0);
    let y = area.y + fy * (area.h - size.1).max(0.0);
    clamp_origin(x, y, size, area)
}

/// First run: the right edge, a little below the middle — away from the menu
/// bar, the traffic lights of most windows and the Dock at the bottom.
pub fn default_origin(size: (f64, f64), area: Rect) -> (f64, f64) {
    let x = area.right() - size.0 - MARGIN;
    let y = area.y + (area.h - size.1) * 0.7;
    clamp_origin(x, y, size, area)
}

/// The panel's frame for a bubble at `bubble`: it grows toward the side with
/// more room on each axis (owner, 2026-11-18: «abrir para o lado da tela com
/// mais espaço»), and is then clamped so no part of it is off-screen.
pub fn expanded_frame(bubble: Rect, panel: (f64, f64), area: Rect) -> (Rect, Anchor) {
    let room_right = area.right() - bubble.x;
    let room_left = bubble.right() - area.x;
    let room_below = area.bottom() - bubble.y;
    let room_above = bubble.bottom() - area.y;
    let right = room_left > room_right; // icon on the right, panel grows left
    let bottom = room_above > room_below; // icon at the bottom, panel grows up
    let x = if right {
        bubble.right() - panel.0
    } else {
        bubble.x
    };
    let y = if bottom {
        bubble.bottom() - panel.1
    } else {
        bubble.y
    };
    let (x, y) = clamp_origin(x, y, panel, area);
    (
        Rect {
            x,
            y,
            w: panel.0,
            h: panel.1,
        },
        Anchor { right, bottom },
    )
}

/// The screen a point belongs to; a point on no screen (a monitor that was
/// unplugged) falls to the nearest one by centre distance.
pub fn screen_for(x: f64, y: f64, screens: &[Rect]) -> Option<usize> {
    if let Some(i) = screens.iter().position(|r| r.contains(x, y)) {
        return Some(i);
    }
    screens
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
            (i, (cx - x).powi(2) + (cy - y).powi(2))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

// ---- config -----------------------------------------------------------------

pub fn read_cfg() -> BubbleCfg {
    read_loro_config().balao.unwrap_or_default()
}

fn write_cfg(cfg: &BubbleCfg) -> Result<(), String> {
    let mut all = read_loro_config();
    all.balao = Some(cfg.clone());
    write_loro_config(&all)
}

// ---- the window -------------------------------------------------------------

#[derive(Default)]
struct Runtime {
    expanded: bool,
    // where the icon was before it grew, where the panel was put, and which
    // corner the icon is in: collapsing goes back exactly there — or, if the
    // panel was dragged meanwhile, to where its icon corner is now
    collapsed_at: Option<(f64, f64)>,
    expanded_at: Option<(f64, f64)>,
    anchor: Option<Anchor>,
    // a generation counter for the debounced save of a drag
    save_gen: u64,
    // the main window is in front: the bubble is out of the way for now
    main_focused: bool,
}

static RT: Mutex<Option<Runtime>> = Mutex::new(None);

fn with_rt<T>(f: impl FnOnce(&mut Runtime) -> T) -> T {
    let mut g = RT.lock().unwrap_or_else(|p| p.into_inner());
    f(g.get_or_insert_with(Runtime::default))
}

struct Screen {
    name: String,
    area: Rect,
    scale: f64,
}

fn screens(w: &tauri::WebviewWindow) -> Vec<Screen> {
    w.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let wa = m.work_area();
            Screen {
                name: m.name().cloned().unwrap_or_else(|| "tela".into()),
                area: Rect {
                    x: wa.position.x as f64,
                    y: wa.position.y as f64,
                    w: wa.size.width as f64,
                    h: wa.size.height as f64,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

fn phys(size: (f64, f64), scale: f64) -> (f64, f64) {
    (size.0 * scale, size.1 * scale)
}

fn window_rect(w: &tauri::WebviewWindow) -> Option<Rect> {
    let p = w.outer_position().ok()?;
    let s = w.outer_size().ok()?;
    Some(Rect {
        x: p.x as f64,
        y: p.y as f64,
        w: s.width as f64,
        h: s.height as f64,
    })
}

/// Creates the bubble window (hidden), places it, and shows it unless the
/// person hid it. Called once from `setup`.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let w = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("bubble.html".into()))
        .title("Loro")
        .inner_size(
            collapsed_for(read_cfg().tamanho).0,
            collapsed_for(read_cfg().tamanho).1,
        )
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        // showing it must not take the keyboard from the meeting app
        .focused(false)
        // the first click on it acts, instead of only activating Loro
        .accept_first_mouse(true)
        .visible(false)
        .build()?;
    apply_platform_behavior(&w);
    place_collapsed(&w);
    if read_cfg().visivel {
        let _ = w.show();
    }
    Ok(())
}

/// Restores the saved spot for the screen the bubble is on (or the first
/// screen), clamped to what is visible now.
fn place_collapsed(w: &tauri::WebviewWindow) {
    let list = screens(w);
    if list.is_empty() {
        return;
    }
    let cfg = read_cfg();
    // the screen it was last left on, if still connected; else any connected
    // screen it has a spot on; else the first screen
    let idx = cfg
        .tela
        .as_ref()
        .and_then(|t| list.iter().position(|s| &s.name == t))
        .or_else(|| list.iter().position(|s| cfg.posicoes.contains_key(&s.name)))
        .unwrap_or(0);
    let s = &list[idx];
    let size = phys(collapsed_for(cfg.tamanho), s.scale);
    let (x, y) = match cfg.posicoes.get(&s.name) {
        Some(spot) => origin_of(*spot, size, s.area),
        None => default_origin(size, s.area),
    };
    let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// Called on every tick (and after a drag): a bubble left on a screen that was
/// unplugged, or pushed out by a resolution change, comes back into view.
pub fn clamp_into_view(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    if with_rt(|r| r.expanded) {
        return;
    }
    let Some(rect) = window_rect(&w) else {
        return;
    };
    let list = screens(&w);
    let areas: Vec<Rect> = list.iter().map(|s| s.area).collect();
    let Some(i) = screen_for(rect.x + rect.w / 2.0, rect.y + rect.h / 2.0, &areas) else {
        return;
    };
    let (x, y) = clamp_origin(rect.x, rect.y, (rect.w, rect.h), areas[i]);
    if (x - rect.x).abs() >= 1.0 || (y - rect.y).abs() >= 1.0 {
        let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

/// `WindowEvent::Moved` of the bubble: while collapsed, a move is the person
/// dragging it — save the spot once the drag settles (the event fires on every
/// frame of a drag; one write per drag, not hundreds).
pub fn on_moved(app: &AppHandle) {
    if with_rt(|r| r.expanded) {
        return;
    }
    let gen = with_rt(|r| {
        r.save_gen += 1;
        r.save_gen
    });
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        if with_rt(|r| r.save_gen != gen || r.expanded) {
            return;
        }
        save_spot(&app);
    });
}

fn save_spot(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    let Some(rect) = window_rect(&w) else {
        return;
    };
    let list = screens(&w);
    let areas: Vec<Rect> = list.iter().map(|s| s.area).collect();
    let Some(i) = screen_for(rect.x + rect.w / 2.0, rect.y + rect.h / 2.0, &areas) else {
        return;
    };
    let mut cfg = read_cfg();
    cfg.posicoes.insert(
        list[i].name.clone(),
        spot_of(rect.x, rect.y, (rect.w, rect.h), areas[i]),
    );
    cfg.tela = Some(list[i].name.clone());
    if let Err(e) = write_cfg(&cfg) {
        tracing::warn!(error = %e, "bubble: position not saved");
    }
}

/// Grow into the panel (or shrink back). Returns the corner the icon is in, so
/// the panel draws its header on that side.
#[tauri::command]
pub fn bubble_expand(app: AppHandle, expanded: bool) -> Result<Anchor, String> {
    let w = app.get_webview_window(LABEL).ok_or("err.bubble_missing")?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let rect = window_rect(&w).ok_or("err.bubble_missing")?;
    let collapsed = phys(collapsed_for(read_cfg().tamanho), scale);
    let panel = phys(EXPANDED, scale);
    if !expanded {
        let (was, at, from, anchor) = with_rt(|r| {
            let was = r.expanded;
            r.expanded = false;
            (
                was,
                r.expanded_at.take(),
                r.collapsed_at.take(),
                r.anchor.take(),
            )
        });
        let _ = w.set_size(PhysicalSize::new(collapsed.0 as u32, collapsed.1 as u32));
        if was {
            // the panel's CURRENT size: the chat may have grown it (§3)
            let (x, y) = collapsed_origin(
                (rect.x, rect.y),
                at,
                from,
                anchor,
                (rect.w, rect.h),
                collapsed,
            );
            let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        }
        clamp_into_view(&app);
        return Ok(Anchor {
            right: false,
            bottom: false,
        });
    }
    // already open (a second «prompt» while open): nothing moves
    if let Some(a) = with_rt(|r| if r.expanded { r.anchor } else { None }) {
        return Ok(a);
    }
    let list = screens(&w);
    let areas: Vec<Rect> = list.iter().map(|s| s.area).collect();
    let i = screen_for(rect.x + rect.w / 2.0, rect.y + rect.h / 2.0, &areas)
        .ok_or("err.bubble_missing")?;
    let (frame, anchor) = expanded_frame(rect, panel, areas[i]);
    with_rt(|r| {
        r.collapsed_at = Some((rect.x, rect.y));
        r.expanded_at = Some((frame.x.round(), frame.y.round()));
        r.anchor = Some(anchor);
        r.expanded = true;
    });
    let _ = w.set_size(PhysicalSize::new(frame.w as u32, frame.h as u32));
    let _ = w.set_position(PhysicalPosition::new(
        frame.x.round() as i32,
        frame.y.round() as i32,
    ));
    Ok(anchor)
}

/// Where the icon goes when the panel closes. Untouched panel: exactly where
/// the icon sat before it grew. A panel the person dragged: the icon lands on
/// the corner it is drawn in, wherever the panel was left.
pub fn collapsed_origin(
    now: (f64, f64),
    expanded_at: Option<(f64, f64)>,
    collapsed_at: Option<(f64, f64)>,
    anchor: Option<Anchor>,
    panel: (f64, f64),
    collapsed: (f64, f64),
) -> (f64, f64) {
    let moved =
        expanded_at.is_none_or(|e| (e.0 - now.0).abs() >= 2.0 || (e.1 - now.1).abs() >= 2.0);
    if let (false, Some(c)) = (moved, collapsed_at) {
        return c;
    }
    let a = anchor.unwrap_or(Anchor {
        right: false,
        bottom: false,
    });
    let x = if a.right {
        now.0 + panel.0 - collapsed.0
    } else {
        now.0
    };
    let y = if a.bottom {
        now.1 + panel.1 - collapsed.1
    } else {
        now.1
    };
    (x, y)
}

/// The panel's new height when its content grows (the chat): never shorter than
/// the base panel, never taller than 70% of the screen, growing AWAY from the
/// icon (an icon at the bottom grows the panel upward) and kept on-screen.
pub fn grown_frame(frame: Rect, anchor: Anchor, want_h: f64, area: Rect) -> Rect {
    let max_h = (area.h * 0.7).max(EXPANDED.1.min(area.h));
    let h = want_h.clamp(EXPANDED.1.min(max_h), max_h);
    let y = if anchor.bottom {
        frame.bottom() - h
    } else {
        frame.y
    };
    let (x, y) = clamp_origin(frame.x, y, (frame.w, h), area);
    Rect {
        x,
        y,
        w: frame.w,
        h,
    }
}

/// ADR-0041 §3 — the bubble asks for a taller (or back to the base) panel when
/// its chat grows. `height` in pt. No-op while collapsed.
#[tauri::command]
pub fn bubble_panel_height(app: AppHandle, height: f64) -> Result<f64, String> {
    let w = app.get_webview_window(LABEL).ok_or("err.bubble_missing")?;
    let Some(anchor) = with_rt(|r| if r.expanded { r.anchor } else { None }) else {
        return Ok(0.0);
    };
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let rect = window_rect(&w).ok_or("err.bubble_missing")?;
    let list = screens(&w);
    let areas: Vec<Rect> = list.iter().map(|s| s.area).collect();
    let i = screen_for(rect.x + rect.w / 2.0, rect.y + rect.h / 2.0, &areas)
        .ok_or("err.bubble_missing")?;
    // pt → px for the geometry, px → pt for the answer
    let area = areas[i];
    let f = grown_frame(rect, anchor, height * scale, area);
    with_rt(|r| r.expanded_at = Some((f.x.round(), f.y.round())));
    let _ = w.set_size(PhysicalSize::new(f.w as u32, f.h as u32));
    let _ = w.set_position(PhysicalPosition::new(
        f.x.round() as i32,
        f.y.round() as i32,
    ));
    Ok(f.h / scale)
}

/// Show or hide the bubble, and remember it (Settings, the tray item).
#[tauri::command]
pub fn bubble_set_visible(app: AppHandle, visible: bool) -> Result<bool, String> {
    set_visible(&app, visible)
}

#[tauri::command]
pub fn bubble_get_visible() -> bool {
    read_cfg().visivel
}

/// The icon size (32/48/64 pt). The bubble window reads it on load and on
/// `bubble-size`.
#[tauri::command]
pub fn bubble_get_size() -> u32 {
    normalize_size(read_cfg().tamanho)
}

/// Change the icon size: persisted, the collapsed window resized in place
/// (keeping its top-left), and the bubble told to redraw.
#[tauri::command]
pub fn bubble_set_size(app: AppHandle, size: u32) -> Result<u32, String> {
    let size = normalize_size(size);
    let mut cfg = read_cfg();
    cfg.tamanho = size;
    write_cfg(&cfg)?;
    if let Some(w) = app.get_webview_window(LABEL) {
        if !with_rt(|r| r.expanded) {
            let scale = w.scale_factor().unwrap_or(1.0);
            let c = phys(collapsed_for(size), scale);
            let _ = w.set_size(PhysicalSize::new(c.0 as u32, c.1 as u32));
            clamp_into_view(&app);
        }
    }
    let _ = app.emit("bubble-size", size);
    Ok(size)
}

pub fn set_visible(app: &AppHandle, visible: bool) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        // an explicit «show» (tray, Settings, ⌘K, the recording bar) shows it
        // NOW, even over the main window: the person asked for it
        if visible {
            w.show().map_err(|e| e.to_string())?;
            let _ = w.set_always_on_top(true);
        } else {
            w.hide().map_err(|e| e.to_string())?;
        }
    }
    let mut cfg = read_cfg();
    cfg.visivel = visible;
    write_cfg(&cfg)?;
    let _ = app.emit("bubble-visible", visible);
    Ok(visible)
}

/// Whether the bubble stays out of the way right now (the person wants it
/// shown, but asked it to step aside while the main window is in front).
pub fn steps_aside(cfg: &BubbleCfg, main_focused: bool) -> bool {
    cfg.ocultar_com_janela && main_focused
}

/// `WindowEvent::Focused` of the main window: hide the bubble while that window
/// is in front, bring it back when it is not. Never touches `visivel`.
pub fn on_main_focus(app: &AppHandle, focused: bool) {
    with_rt(|r| r.main_focused = focused);
    let cfg = read_cfg();
    if !cfg.visivel {
        return;
    }
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    if steps_aside(&cfg, focused) {
        let _ = w.hide();
    } else if !w.is_visible().unwrap_or(true) {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
    }
}

#[tauri::command]
pub fn bubble_get_auto_hide() -> bool {
    read_cfg().ocultar_com_janela
}

/// «ocultar o balão com a janela do Loro em primeiro plano» (Settings).
#[tauri::command]
pub fn bubble_set_auto_hide(app: AppHandle, on: bool) -> Result<bool, String> {
    let mut cfg = read_cfg();
    cfg.ocultar_com_janela = on;
    write_cfg(&cfg)?;
    // the Settings checkbox is IN the main window, so it is in front now
    on_main_focus(&app, with_rt(|r| r.main_focused));
    Ok(on)
}

pub fn toggle_visible(app: &AppHandle) {
    let now = app
        .get_webview_window(LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if let Err(e) = set_visible(app, !now) {
        tracing::warn!(error = %e, "bubble: visibility not changed");
    }
}

// ---- macOS: every Space, over fullscreen apps --------------------------------

// NSWindowCollectionBehavior bits (AppKit, NSWindow.h): the bubble joins every
// Space, stays put when the Space slides, may sit beside a fullscreen app, and is
// skipped by Cmd+` window cycling.
#[cfg(target_os = "macos")]
const NS_CAN_JOIN_ALL_SPACES: usize = 1 << 0;
#[cfg(target_os = "macos")]
const NS_STATIONARY: usize = 1 << 4;
#[cfg(target_os = "macos")]
const NS_IGNORES_CYCLE: usize = 1 << 6;
#[cfg(target_os = "macos")]
const NS_FULL_SCREEN_AUXILIARY: usize = 1 << 8;
// kCGStatusWindowLevel (25): above normal and floating windows, so the bubble
// stays over a fullscreen app's window; below the screen saver and alerts.
#[cfg(target_os = "macos")]
const NS_STATUS_WINDOW_LEVEL: isize = 25;

#[cfg(target_os = "macos")]
pub fn collection_behavior() -> usize {
    NS_CAN_JOIN_ALL_SPACES | NS_STATIONARY | NS_IGNORES_CYCLE | NS_FULL_SCREEN_AUXILIARY
}

#[cfg(target_os = "macos")]
fn apply_platform_behavior(w: &tauri::WebviewWindow) {
    let w2 = w.clone();
    let _ = w.run_on_main_thread(move || {
        let Ok(ns) = w2.ns_window() else {
            return;
        };
        if ns.is_null() {
            return;
        }
        // SAFETY: `ns_window` is the live NSWindow of this webview window, and
        // this closure runs on the main thread, where AppKit must be called.
        unsafe {
            let obj = &*(ns as *mut objc2::runtime::AnyObject);
            let _: () = objc2::msg_send![obj, setCollectionBehavior: collection_behavior()];
            let _: () = objc2::msg_send![obj, setLevel: NS_STATUS_WINDOW_LEVEL];
            // an inactive Loro must not take the bubble with it
            let _: () = objc2::msg_send![obj, setHidesOnDeactivate: false];
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_platform_behavior(_w: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 25.0,
        w: 1440.0,
        h: 850.0,
    };

    #[test]
    fn adr0041_absent_config_shows_the_bubble_and_ignores_a_leftover_dia_gravado() {
        // a config written by v0.19 still carries ADR-0038's key: it must read,
        // and the bubble is visible by default
        let json = r#"{"acervos":[],"active":"","diaGravado":{"ligado":true,"inicio":"09:00","fim":"18:30"}}"#;
        let cfg: crate::config::LoroConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.balao.is_none());
        assert!(BubbleCfg::default().visivel);
        let back = serde_json::to_string(&cfg).unwrap();
        assert!(!back.contains("diaGravado"), "{back}");
        assert!(!back.contains("balao"), "absent stays absent: {back}");
    }

    #[test]
    fn adr0041_the_config_shape_round_trips() {
        let json = r#"{"visivel":false,"tela":"Built-in Retina Display","posicoes":{"Built-in Retina Display":{"fx":1.0,"fy":0.5},"DELL U2720Q":{"fx":0.0,"fy":0.0}}}"#;
        let cfg: BubbleCfg = serde_json::from_str(json).unwrap();
        assert!(!cfg.visivel);
        assert_eq!(cfg.tela.as_deref(), Some("Built-in Retina Display"));
        assert_eq!(cfg.posicoes.len(), 2, "one spot per screen");
        assert_eq!(
            cfg.posicoes["Built-in Retina Display"],
            Spot { fx: 1.0, fy: 0.5 }
        );
        let back = serde_json::to_string(&cfg).unwrap();
        assert_eq!(serde_json::from_str::<BubbleCfg>(&back).unwrap(), cfg);
        // `visivel` absent = shown
        let bare: BubbleCfg = serde_json::from_str("{}").unwrap();
        assert!(bare.visivel);
        assert_eq!(bare.tamanho, 32, "absent size = pequeno (32 pt)");
    }

    #[test]
    fn adr0041_the_size_is_one_of_three_and_defaults_to_32() {
        assert_eq!(DEFAULT_SIZE, 32);
        for s in [32, 48, 64] {
            assert_eq!(normalize_size(s), s);
        }
        for bad in [0, 16, 33, 100, u32::MAX] {
            assert_eq!(normalize_size(bad), 32, "{bad}");
        }
        // the window is the icon plus its padding on each side
        assert_eq!(collapsed_for(32), (44.0, 44.0));
        assert_eq!(collapsed_for(64), (76.0, 76.0));
        assert_eq!(collapsed_for(7), (44.0, 44.0));
        // 32 pt is a quarter of the 64 pt icon's area
        assert_eq!(32 * 32 * 4, 64 * 64);
    }

    #[test]
    fn adr0041_the_bubble_steps_aside_only_while_the_main_window_is_in_front() {
        let mut cfg = BubbleCfg::default();
        assert!(cfg.ocultar_com_janela, "on by default (owner, 2026-11-19)");
        assert!(steps_aside(&cfg, true));
        assert!(!steps_aside(&cfg, false));
        cfg.ocultar_com_janela = false;
        assert!(!steps_aside(&cfg, true));
        // an older config without the field keeps the default
        let old: BubbleCfg = serde_json::from_str(r#"{"visivel":true}"#).unwrap();
        assert!(old.ocultar_com_janela);
    }

    #[test]
    fn adr0041_clamp_keeps_the_bubble_on_screen() {
        assert_eq!(
            clamp_origin(-50.0, -50.0, (84.0, 84.0), SCREEN),
            (0.0, 25.0)
        );
        assert_eq!(
            clamp_origin(5000.0, 5000.0, (84.0, 84.0), SCREEN),
            (1440.0 - 84.0, 875.0 - 84.0)
        );
        assert_eq!(
            clamp_origin(100.0, 200.0, (84.0, 84.0), SCREEN),
            (100.0, 200.0)
        );
        // a window bigger than the screen is pinned to its top-left
        let tiny = Rect {
            x: 0.0,
            y: 0.0,
            w: 200.0,
            h: 200.0,
        };
        assert_eq!(clamp_origin(50.0, 50.0, (340.0, 520.0), tiny), (0.0, 0.0));
    }

    #[test]
    fn adr0041_a_saved_spot_survives_a_resolution_change() {
        let size = (84.0, 84.0);
        let spot = spot_of(1440.0 - 84.0, 25.0, size, SCREEN);
        assert_eq!(spot, Spot { fx: 1.0, fy: 0.0 });
        // same screen, now 1920 wide: still at the right edge, not mid-screen
        let wider = Rect {
            w: 1920.0,
            h: 1050.0,
            ..SCREEN
        };
        assert_eq!(origin_of(spot, size, wider), (1920.0 - 84.0, 25.0));
        // a corrupted fraction is clamped, never thrown off-screen
        let bad = Spot { fx: 7.0, fy: -3.0 };
        assert_eq!(origin_of(bad, size, SCREEN), (1440.0 - 84.0, 25.0));
        let nan = Spot {
            fx: f64::NAN,
            fy: f64::NAN,
        };
        let (x, y) = origin_of(nan, size, SCREEN);
        assert!(SCREEN.contains(x, y));
    }

    #[test]
    fn adr0041_first_run_sits_on_the_right_edge() {
        let (x, y) = default_origin((84.0, 84.0), SCREEN);
        assert_eq!(x, 1440.0 - 84.0 - MARGIN);
        assert!(y > 25.0 + 850.0 / 2.0 - 84.0 && y + 84.0 <= 875.0);
    }

    #[test]
    fn adr0041_the_panel_opens_toward_the_side_with_more_room() {
        let panel = (340.0, 520.0);
        // icon near the top-left: grows right and down, icon in the top-left corner
        let tl = Rect {
            x: 20.0,
            y: 40.0,
            w: 84.0,
            h: 84.0,
        };
        let (f, a) = expanded_frame(tl, panel, SCREEN);
        assert_eq!(
            a,
            Anchor {
                right: false,
                bottom: false
            }
        );
        assert_eq!((f.x, f.y), (20.0, 40.0));
        // icon at the bottom-right: grows left and up, icon stays where it was
        let br = Rect {
            x: 1340.0,
            y: 770.0,
            w: 84.0,
            h: 84.0,
        };
        let (f, a) = expanded_frame(br, panel, SCREEN);
        assert_eq!(
            a,
            Anchor {
                right: true,
                bottom: true
            }
        );
        assert_eq!((f.right(), f.bottom()), (br.right(), br.bottom()));
        // and the panel never leaves the screen
        for b in [tl, br] {
            let (f, _) = expanded_frame(b, panel, SCREEN);
            assert!(f.x >= SCREEN.x && f.right() <= SCREEN.right());
            assert!(f.y >= SCREEN.y && f.bottom() <= SCREEN.bottom());
        }
        // a short screen: the panel is clamped instead of hanging off the top
        let short = Rect {
            x: 0.0,
            y: 0.0,
            w: 1280.0,
            h: 600.0,
        };
        let mid = Rect {
            x: 600.0,
            y: 280.0,
            w: 84.0,
            h: 84.0,
        };
        let (f, _) = expanded_frame(mid, panel, short);
        assert!(f.y >= 0.0 && f.bottom() <= 600.0, "{f:?}");
    }

    #[test]
    fn adr0041_closing_the_panel_returns_the_icon_where_it_was_or_where_it_was_dragged() {
        let panel = (340.0, 520.0);
        let small = (84.0, 84.0);
        let br = Some(Anchor {
            right: true,
            bottom: true,
        });
        // untouched (even if the panel had to be clamped): back to the exact spot
        assert_eq!(
            collapsed_origin(
                (1000.0, 300.0),
                Some((1000.0, 300.0)),
                Some((1256.0, 736.0)),
                br,
                panel,
                small
            ),
            (1256.0, 736.0)
        );
        // dragged while open: the icon lands on its corner of the panel
        assert_eq!(
            collapsed_origin(
                (500.0, 100.0),
                Some((1000.0, 300.0)),
                Some((1256.0, 736.0)),
                br,
                panel,
                small
            ),
            (500.0 + 340.0 - 84.0, 100.0 + 520.0 - 84.0)
        );
        let tl = Some(Anchor {
            right: false,
            bottom: false,
        });
        assert_eq!(
            collapsed_origin(
                (40.0, 60.0),
                Some((20.0, 40.0)),
                Some((20.0, 40.0)),
                tl,
                panel,
                small
            ),
            (40.0, 60.0)
        );
    }

    #[test]
    fn adr0041_the_chat_grows_the_panel_away_from_the_icon_up_to_70_percent() {
        let top = Anchor {
            right: false,
            bottom: false,
        };
        let bottom = Anchor {
            right: true,
            bottom: true,
        };
        let f = Rect {
            x: 100.0,
            y: 100.0,
            w: 340.0,
            h: 520.0,
        };
        // grows down from a top icon
        let g = grown_frame(f, top, 580.0, SCREEN);
        assert_eq!((g.x, g.y, g.h), (100.0, 100.0, 580.0));
        // capped at 70% of the screen (850 * 0.7 = 595), and back up when clamped
        let g = grown_frame(f, top, 2000.0, SCREEN);
        assert_eq!(g.h, 595.0);
        assert!(g.bottom() <= SCREEN.bottom());
        // never shorter than the base panel
        assert_eq!(grown_frame(f, top, 100.0, SCREEN).h, 520.0);
        // an icon at the bottom: the panel grows UP, its bottom edge stays
        let low = Rect {
            x: 900.0,
            y: 300.0,
            w: 340.0,
            h: 520.0,
        };
        let g = grown_frame(low, bottom, 590.0, SCREEN);
        assert_eq!(g.bottom(), low.bottom());
        assert_eq!(g.h, 590.0);
    }

    #[test]
    fn adr0041_a_bubble_on_an_unplugged_screen_goes_to_the_nearest() {
        let left = Rect {
            x: -1920.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        };
        assert_eq!(screen_for(-500.0, 300.0, &[SCREEN, left]), Some(1));
        assert_eq!(screen_for(700.0, 300.0, &[SCREEN, left]), Some(0));
        // the external screen is gone: the point is on no screen, nearest wins
        assert_eq!(screen_for(-500.0, 300.0, &[SCREEN]), Some(0));
        assert_eq!(screen_for(0.0, 0.0, &[]), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn adr0041_macos_behavior_joins_all_spaces_and_fullscreen() {
        let b = collection_behavior();
        assert_eq!(b & 1, 1, "canJoinAllSpaces");
        assert_eq!(b & (1 << 8), 1 << 8, "fullScreenAuxiliary");
        assert_eq!(
            b & (1 << 1),
            0,
            "never moveToActiveSpace with canJoinAllSpaces"
        );
        const _: () = assert!(NS_STATUS_WINDOW_LEVEL > 3, "above NSFloatingWindowLevel");
    }
}
