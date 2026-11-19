// ADR-0042 — «Permissões do Claude»: what every agent run Loro starts may do
// without asking. One person-level setting, one pure flag builder, three surfaces
// (the main chat, the bubble's chat, a loop cycle).
//
// The owner (2026-11-18): «vamos liberar de acordo com os pedidos sem
// pré-autorização». So the NEW DEFAULT is «livre»: `--permission-mode
// bypassPermissions`, no Bash block, writes allowed outside the project. «restrito»
// keeps the ADR-0029/ADR-0021 model exactly as it was (acceptEdits; a cycle never
// gets Bash). What stays in BOTH modes is a deny list of the tools that ACT on other
// people — send, share, trash, answer an invite — passed as `--disallowedTools`:
// always for a loop (nobody is watching it), and for the bubble's chat only behind
// its own toggle (off by default: there the owner is typing the request himself).
//
// The setting is the PERSON's, in ~/.loro/config.json (`permissoesClaude`), never in
// the acervo's versioned `.loro/settings.json`: a teammate's commit must not be able
// to widen what the owner's agent may do.

use serde::{Deserialize, Serialize};

use crate::config::{read_loro_config, write_loro_config};

/// The owner's standing rule for unattended runs: tools that send, publish, share,
/// delete or answer on his behalf.
pub const DEFAULT_DENYLIST: [&str; 14] = [
    "mcp__claude_ai_Slack__slack_send_message",
    "mcp__claude_ai_Slack__slack_send_message_draft",
    "mcp__claude_ai_Slack__slack_schedule_message",
    "mcp__claude_ai_Slack__slack_create_conversation",
    "mcp__claude_ai_Slack__slack_add_reaction",
    "mcp__claude_ai_Slack__slack_create_canvas",
    "mcp__claude_ai_Slack__slack_update_canvas",
    "mcp__claude_ai_Gmail__create_draft",
    "mcp__claude_ai_Gmail__trash_message",
    "mcp__claude_ai_Gmail__trash_thread",
    "mcp__claude_ai_Google_Drive__share_file",
    "mcp__claude_ai_Google_Drive__trash_file",
    "mcp__claude_ai_Google_Calendar__delete_event",
    "mcp__claude_ai_Google_Calendar__respond_to_event",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPerms {
    /// "livre" (default) | "restrito"
    #[serde(default = "livre")]
    pub modo: String,
    /// `--disallowedTools` — editable; pre-filled with DEFAULT_DENYLIST
    #[serde(default = "default_denylist")]
    pub bloqueio: Vec<String>,
    /// apply the deny list to the bubble's chat too (default off)
    #[serde(default)]
    pub bloquear_no_chat: bool,
}

fn livre() -> String {
    "livre".into()
}
fn default_denylist() -> Vec<String> {
    DEFAULT_DENYLIST.iter().map(|s| s.to_string()).collect()
}

impl Default for AgentPerms {
    fn default() -> Self {
        Self {
            modo: livre(),
            bloqueio: default_denylist(),
            bloquear_no_chat: false,
        }
    }
}

impl AgentPerms {
    pub fn is_free(&self) -> bool {
        self.modo != "restrito"
    }
}

/// Which run is asking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    /// the main window's chat (also how brainstorm/review «pedir à IA» runs)
    Chat,
    /// the recording bubble's mini chat
    Bubble,
    /// an unattended loop cycle
    Loop,
}

/// The value passed to `--permission-mode`. Livre: bypass, everywhere. Restrito:
/// what each surface had before ADR-0042 — the main chat's own choice (ADR-0021),
/// `acceptEdits` for the bubble and for a cycle (ADR-0029 §4.9).
pub fn permission_mode(p: &AgentPerms, s: Surface, chat_choice: &str) -> &'static str {
    if p.is_free() {
        return "bypassPermissions";
    }
    match s {
        Surface::Chat => match chat_choice.trim() {
            "bypassPermissions" | "tudo" => "bypassPermissions",
            _ => "acceptEdits",
        },
        Surface::Bubble | Surface::Loop => "acceptEdits",
    }
}

/// The tool flags that follow `--permission-mode`. Pure: what a run may reach is a
/// fact with a test.
///
/// - Loop: the deny list ALWAYS, plus what the person refused for cycles; in
///   «restrito» also `Bash` (ADR-0029 §4.18's lock) and the granted `--allowedTools`.
/// - Bubble: the deny list only when `bloquear_no_chat`.
/// - Chat: nothing (as before ADR-0042).
pub fn tool_flags(
    p: &AgentPerms,
    s: Surface,
    permite: &[String],
    recusa: &[String],
) -> Vec<String> {
    let deny = crate::loops::clean_refusals(&p.bloqueio);
    let mut out: Vec<String> = Vec::new();
    match s {
        Surface::Chat => {}
        Surface::Bubble => {
            if p.bloquear_no_chat && !deny.is_empty() {
                out.push("--disallowedTools".into());
                out.push(deny.join(","));
            }
        }
        Surface::Loop => {
            if p.is_free() {
                let mut refused = crate::loops::clean_refusals(recusa);
                for t in deny {
                    if !refused.contains(&t) {
                        refused.push(t);
                    }
                }
                if !refused.is_empty() {
                    out.push("--disallowedTools".into());
                    out.push(refused.join(","));
                }
            } else {
                // the ADR-0029 lock, unchanged — plus the deny list
                let mut all: Vec<String> = recusa.to_vec();
                all.extend(deny);
                out = crate::loops::cycle_tool_flags(permite, &all);
            }
        }
    }
    out
}

pub fn read() -> AgentPerms {
    read_loro_config().permissoes_claude.unwrap_or_default()
}

fn normalize(p: AgentPerms) -> AgentPerms {
    AgentPerms {
        modo: if p.modo == "restrito" {
            "restrito".into()
        } else {
            "livre".into()
        },
        bloqueio: crate::loops::clean_refusals(&p.bloqueio),
        bloquear_no_chat: p.bloquear_no_chat,
    }
}

#[tauri::command]
pub fn agent_perms_get() -> AgentPerms {
    read()
}

#[tauri::command]
pub fn agent_perms_set(perms: AgentPerms) -> Result<AgentPerms, String> {
    let p = normalize(perms);
    let mut cfg = read_loro_config();
    cfg.permissoes_claude = Some(p.clone());
    write_loro_config(&cfg)?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn restrito() -> AgentPerms {
        AgentPerms {
            modo: "restrito".into(),
            ..AgentPerms::default()
        }
    }
    fn joined(v: &[String]) -> String {
        v.join(" ")
    }

    #[test]
    fn adr0042_absent_config_is_free_with_the_owners_denylist_and_chat_unblocked() {
        let cfg: crate::config::LoroConfig =
            serde_json::from_str(r#"{"acervos":[],"active":""}"#).unwrap();
        assert!(cfg.permissoes_claude.is_none());
        let p = AgentPerms::default();
        assert!(p.is_free());
        assert_eq!(p.bloqueio.len(), 14);
        assert!(p
            .bloqueio
            .contains(&"mcp__claude_ai_Slack__slack_send_message".to_string()));
        assert!(p
            .bloqueio
            .contains(&"mcp__claude_ai_Google_Calendar__respond_to_event".to_string()));
        assert!(!p.bloquear_no_chat);
        // and the stored shape round-trips under its key
        let json = r#"{"modo":"restrito","bloqueio":["mcp__x__y"],"bloquearNoChat":true}"#;
        let q: AgentPerms = serde_json::from_str(json).unwrap();
        assert!(!q.is_free() && q.bloquear_no_chat && q.bloqueio == vec!["mcp__x__y"]);
    }

    #[test]
    fn adr0042_free_mode_bypasses_on_every_surface() {
        let p = AgentPerms::default();
        for s in [Surface::Chat, Surface::Bubble, Surface::Loop] {
            assert_eq!(
                permission_mode(&p, s, "acceptEdits"),
                "bypassPermissions",
                "{s:?}"
            );
        }
    }

    #[test]
    fn adr0042_restricted_mode_is_exactly_what_it_was() {
        let p = restrito();
        assert_eq!(permission_mode(&p, Surface::Chat, ""), "acceptEdits");
        assert_eq!(
            permission_mode(&p, Surface::Chat, "tudo"),
            "bypassPermissions"
        );
        assert_eq!(permission_mode(&p, Surface::Bubble, "tudo"), "acceptEdits");
        assert_eq!(
            permission_mode(&p, Surface::Loop, "bypassPermissions"),
            "acceptEdits"
        );
        // a cycle still never gets Bash, and the deny list rides along
        let f = joined(&tool_flags(&p, Surface::Loop, &["WebFetch".into()], &[]));
        assert!(f.contains("--allowedTools WebFetch"), "{f}");
        let deny = f.split("--disallowedTools ").nth(1).unwrap();
        assert!(deny.split(',').any(|t| t == "Bash"), "{f}");
        assert!(deny.contains("mcp__claude_ai_Gmail__trash_thread"), "{f}");
    }

    #[test]
    fn adr0042_a_loop_always_gets_the_denylist_but_no_bash_block_when_free() {
        let p = AgentPerms::default();
        let f = tool_flags(&p, Surface::Loop, &[], &["mcp__drive__ler".into()]);
        assert_eq!(f[0], "--disallowedTools");
        let deny: Vec<&str> = f[1].split(',').collect();
        assert!(deny.contains(&"mcp__drive__ler"), "what the person refused");
        assert!(deny.contains(&"mcp__claude_ai_Slack__slack_send_message"));
        assert!(!deny.contains(&"Bash"), "livre: Bash is allowed");
        assert!(
            !f.contains(&"--allowedTools".to_string()),
            "bypass needs no allow list"
        );
        // an emptied deny list leaves no empty flag (the CLI refuses one)
        let empty = AgentPerms {
            bloqueio: vec![],
            ..AgentPerms::default()
        };
        assert!(tool_flags(&empty, Surface::Loop, &[], &[]).is_empty());
    }

    #[test]
    fn adr0042_the_bubble_chat_blocks_sends_only_behind_its_toggle() {
        let off = AgentPerms::default();
        assert!(tool_flags(&off, Surface::Bubble, &[], &[]).is_empty());
        let on = AgentPerms {
            bloquear_no_chat: true,
            ..AgentPerms::default()
        };
        let f = tool_flags(&on, Surface::Bubble, &[], &[]);
        assert_eq!(f[0], "--disallowedTools");
        assert!(f[1].contains("mcp__claude_ai_Google_Drive__share_file"));
        // the main chat is untouched by either
        assert!(tool_flags(&on, Surface::Chat, &[], &[]).is_empty());
        assert!(tool_flags(&restrito(), Surface::Chat, &[], &[]).is_empty());
    }

    #[test]
    fn adr0042_what_is_stored_is_cleaned_and_the_mode_is_one_of_two() {
        let p = normalize(AgentPerms {
            modo: "tudo".into(),
            bloqueio: vec![
                " mcp__a__b ".into(),
                "--dangerously".into(),
                "x y".into(),
                "mcp__a__b".into(),
            ],
            bloquear_no_chat: false,
        });
        assert_eq!(p.modo, "livre");
        assert_eq!(p.bloqueio, vec!["mcp__a__b"]);
        assert_eq!(normalize(restrito()).modo, "restrito");
    }
}
