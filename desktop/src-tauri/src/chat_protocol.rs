// Loro — the two-way half of the chat's contract with the Claude CLI (ADR-0043).
//
// ADR-0021 ran the chat as `claude -p` with the prompt as plain text on stdin. In
// that shape the CLI has no one to ask: a tool that needs permission is denied, and
// AskUserQuestion is not even offered to the model. ADR-0043 keeps the same
// process (one per turn, `--resume` between turns) but speaks the CLI's own
// stream-json control protocol, so the PERSON answers what the terminal would
// have asked them.
//
// Every shape below was captured from the installed CLI (2.1.329) on 2026-11-23,
// not taken from documentation:
//   stdin  ← {"type":"user","message":{"role":"user","content":"…"}}
//   stdout → {"type":"control_request","request_id":"…","request":{
//              "subtype":"can_use_tool","tool_name":"AskUserQuestion"|"Write"|…,
//              "input":{…},"description":"…","permission_suggestions":[…],
//              "tool_use_id":"…"}}
//   stdin  ← {"type":"control_response","response":{"subtype":"success",
//              "request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}
// AskUserQuestion only exists when `--permission-prompt-tool stdio` is passed
// (measured: without it the model said the tool "isn't available"). A built-in
// slash command (`/context`) answers with ONE `assistant` message whose model is
// "<synthetic>" and NO text deltas — read only from deltas, it was a blank reply.
//
// Pure functions only: chat.rs owns the process and the AppHandle.

use serde::Serialize;
use serde_json::{json, Value};

/// The model name the CLI writes on a reply it produced locally (a slash command).
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// The prompt as the first line of a stream-json session.
pub(crate) fn user_message_line(prompt: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": prompt}}).to_string()
}

/// The handshake that makes the CLI list its commands without starting a turn.
pub(crate) fn initialize_line(request_id: &str) -> String {
    json!({"type": "control_request", "request_id": request_id,
           "request": {"subtype": "initialize"}})
    .to_string()
}

/// What the person is asked, as the UI receives it (`{ch}-ask`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatAsk {
    pub request_id: String,
    /// "question" (AskUserQuestion: choose among options) or "permission".
    pub kind: String,
    pub tool: String,
    /// The tool's input, as the CLI sent it: the questions, or what would run.
    pub input: Value,
    /// The CLI's own one-line summary of the action, when it gives one.
    pub description: String,
    /// True when the CLI offers to stop asking for this kind of action for the
    /// rest of the session (its `permission_suggestions`).
    pub can_remember: bool,
}

/// A line the reader must act on, beyond the ones ADR-0021 already consumes.
#[derive(Debug, PartialEq)]
pub(crate) enum ControlLine {
    Ask(ChatAsk),
    /// A control request Loro does not implement. It is ANSWERED with an error
    /// instead of ignored: the CLI waits for every request it sends, so silence
    /// would freeze the turn in "pensando…" forever.
    Unsupported {
        request_id: String,
    },
}

pub(crate) fn control_line(v: &Value) -> Option<ControlLine> {
    if v.get("type").and_then(Value::as_str) != Some("control_request") {
        return None;
    }
    let request_id = v.get("request_id").and_then(Value::as_str)?.to_string();
    let req = v.get("request")?;
    if req.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
        return Some(ControlLine::Unsupported { request_id });
    }
    let tool = req
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let kind = if tool == "AskUserQuestion" {
        "question"
    } else {
        "permission"
    };
    Some(ControlLine::Ask(ChatAsk {
        request_id,
        kind: kind.into(),
        input: req.get("input").cloned().unwrap_or_else(|| json!({})),
        description: req
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        can_remember: req
            .get("permission_suggestions")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty()),
        tool,
    }))
}

/// The person's answer, as the UI sends it (`chat_answer`).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAnswer {
    pub request_id: String,
    pub allow: bool,
    /// AskUserQuestion: question text → chosen label(s) or the person's own text.
    #[serde(default)]
    pub answers: Option<Value>,
    /// Permission: also stop asking for this kind of action in this conversation.
    #[serde(default)]
    pub remember: bool,
    /// Deny: what the person wants instead — the model reads it.
    #[serde(default)]
    pub message: String,
}

/// The control_response line for an answer. `input` is the tool's ORIGINAL input:
/// the CLI requires the questions to come back with the answers (SDK contract,
/// and the live probe returned «"Which color…"="Red"» only with them present).
pub(crate) fn answer_line(a: &ChatAnswer, input: &Value, suggestions: &Value) -> String {
    let response = if a.allow {
        let mut updated = input.clone();
        if let (Some(answers), Some(obj)) = (a.answers.as_ref(), updated.as_object_mut()) {
            obj.insert("answers".into(), answers.clone());
        }
        let mut r = json!({"behavior": "allow", "updatedInput": updated});
        if a.remember && suggestions.as_array().is_some_and(|s| !s.is_empty()) {
            r["updatedPermissions"] = suggestions.clone();
        }
        r
    } else {
        let msg = if a.message.trim().is_empty() {
            "The user declined this action."
        } else {
            a.message.trim()
        };
        json!({"behavior": "deny", "message": msg})
    };
    json!({"type": "control_response", "response": {
        "subtype": "success", "request_id": a.request_id, "response": response}})
    .to_string()
}

/// The reply to a control request Loro does not implement.
pub(crate) fn unsupported_line(request_id: &str) -> String {
    json!({"type": "control_response", "response": {
        "subtype": "error", "request_id": request_id,
        "error": "not supported by this host"}})
    .to_string()
}

/// The text of a reply the CLI produced itself (a slash command such as /context).
/// A model reply returns None: its text already arrived as deltas, and emitting it
/// again would print every answer twice.
pub(crate) fn synthetic_text(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let msg = v.get("message")?;
    if msg.get("model").and_then(Value::as_str) != Some(SYNTHETIC_MODEL) {
        return None;
    }
    let text: String = msg
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.trim().is_empty()).then_some(text)
}

/// One command the CLI runs from the chat, as `initialize` lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
}

/// The commands in the `initialize` control_response, or None if `v` is not it.
pub(crate) fn commands_from_initialize(v: &Value, request_id: &str) -> Option<Vec<AgentCommand>> {
    if v.get("type").and_then(Value::as_str) != Some("control_response") {
        return None;
    }
    let r = v.get("response")?;
    if r.get("request_id").and_then(Value::as_str) != Some(request_id) {
        return None;
    }
    let list = r.get("response")?.get("commands")?.as_array()?;
    Some(
        list.iter()
            .filter_map(|c| {
                let name = c.get("name").and_then(Value::as_str)?.trim();
                // names the CLI keeps for itself start with "__"; they are not for people
                if name.is_empty() || name.starts_with("__") {
                    return None;
                }
                let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                Some(AgentCommand {
                    name: name.to_string(),
                    description: s("description"),
                    argument_hint: s("argumentHint"),
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    // Captured from the CLI on 2026-11-23 (only the request_id shortened).
    const ASK: &str = r#"{"type":"control_request","request_id":"e815","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"Pick red as your color."},{"label":"Blue","description":"Pick blue as your color."}],"multiSelect":false}]},"tool_use_id":"toolu_012R","requires_user_interaction":true}}"#;
    const WRITE: &str = r#"{"type":"control_request","request_id":"c335","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/w/x.txt","content":"hi"},"description":"x.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01L3"}}"#;

    #[test]
    fn adr0043_the_prompt_is_a_stream_json_user_message() {
        let v = parse(&user_message_line("diga \"oi\"\nlinha 2"));
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "diga \"oi\"\nlinha 2");
        assert!(
            !user_message_line("a\nb").contains('\n'),
            "one JSON object per LINE: a raw newline would split the message in two"
        );
    }

    #[test]
    fn adr0043_ask_user_question_becomes_a_question_for_the_person() {
        let Some(ControlLine::Ask(a)) = control_line(&parse(ASK)) else {
            panic!("AskUserQuestion was not recognised")
        };
        assert_eq!(a.request_id, "e815");
        assert_eq!(a.kind, "question");
        assert_eq!(a.input["questions"][0]["options"][1]["label"], "Blue");
        assert!(!a.can_remember);
    }

    #[test]
    fn adr0043_a_tool_that_needs_permission_becomes_a_permission_request() {
        let Some(ControlLine::Ask(a)) = control_line(&parse(WRITE)) else {
            panic!("the Write request was not recognised")
        };
        assert_eq!(a.kind, "permission");
        assert_eq!(a.tool, "Write");
        assert_eq!(a.description, "x.txt");
        assert!(a.can_remember, "the CLI offered a session rule");
    }

    #[test]
    fn adr0043_an_unknown_control_request_is_answered_not_ignored() {
        let v = parse(
            r#"{"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback"}}"#,
        );
        assert_eq!(
            control_line(&v),
            Some(ControlLine::Unsupported {
                request_id: "h1".into()
            })
        );
        let r = parse(&unsupported_line("h1"));
        assert_eq!(r["response"]["subtype"], "error");
        assert_eq!(r["response"]["request_id"], "h1");
        // and the ordinary stream is none of its business
        assert_eq!(control_line(&parse(r#"{"type":"result"}"#)), None);
    }

    #[test]
    fn adr0043_an_answer_carries_the_questions_back_with_the_choice() {
        let Some(ControlLine::Ask(a)) = control_line(&parse(ASK)) else {
            panic!()
        };
        let ans = ChatAnswer {
            request_id: a.request_id.clone(),
            allow: true,
            answers: Some(json!({"Which color do you prefer?": "Red"})),
            ..Default::default()
        };
        let r = parse(&answer_line(&ans, &a.input, &Value::Null));
        assert_eq!(r["type"], "control_response");
        assert_eq!(r["response"]["request_id"], "e815");
        let inner = &r["response"]["response"];
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(
            inner["updatedInput"]["answers"]["Which color do you prefer?"],
            "Red"
        );
        assert_eq!(
            inner["updatedInput"]["questions"], a.input["questions"],
            "without the questions the CLI cannot pair the answers"
        );
    }

    #[test]
    fn adr0043_allow_keeps_the_input_and_remember_adds_the_session_rule() {
        let Some(ControlLine::Ask(a)) = control_line(&parse(WRITE)) else {
            panic!()
        };
        let sugg = parse(WRITE)["request"]["permission_suggestions"].clone();
        let once = ChatAnswer {
            request_id: "c335".into(),
            allow: true,
            ..Default::default()
        };
        let r = parse(&answer_line(&once, &a.input, &sugg));
        assert_eq!(
            r["response"]["response"]["updatedInput"]["file_path"],
            "/w/x.txt"
        );
        assert!(r["response"]["response"]
            .get("updatedPermissions")
            .is_none());

        let always = ChatAnswer {
            remember: true,
            ..once
        };
        let r = parse(&answer_line(&always, &a.input, &sugg));
        assert_eq!(
            r["response"]["response"]["updatedPermissions"][0]["mode"],
            "acceptEdits"
        );
    }

    #[test]
    fn adr0043_deny_tells_the_model_why() {
        let deny = ChatAnswer {
            request_id: "c335".into(),
            allow: false,
            message: "escreva em notas/ em vez disso".into(),
            ..Default::default()
        };
        let r = parse(&answer_line(&deny, &json!({}), &Value::Null));
        assert_eq!(r["response"]["response"]["behavior"], "deny");
        assert_eq!(
            r["response"]["response"]["message"],
            "escreva em notas/ em vez disso"
        );
        let bare = ChatAnswer {
            request_id: "x".into(),
            ..Default::default()
        };
        let r = parse(&answer_line(&bare, &json!({}), &Value::Null));
        assert!(!r["response"]["response"]["message"]
            .as_str()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn adr0043_a_slash_command_reply_is_read_from_the_synthetic_message() {
        // /context, captured: one assistant message, model "<synthetic>", no deltas
        let v = parse(
            r###"{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"## Context Usage\n\n**Tokens:** 16.6k"}]}}"###,
        );
        assert_eq!(
            synthetic_text(&v).as_deref(),
            Some("## Context Usage\n\n**Tokens:** 16.6k")
        );
        // a model reply already streamed its text as deltas: never twice
        let real = parse(
            r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"text","text":"ok"}]}}"#,
        );
        assert_eq!(synthetic_text(&real), None);
    }

    #[test]
    fn adr0043_the_command_list_comes_from_initialize() {
        let v = parse(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"i1","response":{"commands":[{"name":"compact","description":"Clear history but keep a summary","argumentHint":"<instructions>"},{"name":"__remote-workflow","description":"","argumentHint":""},{"name":"turbo:ask","description":"Consulta o acervo","argumentHint":""}]}}}"#,
        );
        let cmds = commands_from_initialize(&v, "i1").unwrap();
        let names: Vec<&str> = cmds.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["compact", "turbo:ask"],
            "internal names are dropped"
        );
        assert_eq!(cmds[0].argument_hint, "<instructions>");
        assert_eq!(commands_from_initialize(&v, "other"), None);
    }
}
