use serde_json::Value;

pub(super) fn normalize_languages(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut languages = Vec::new();
    for value in values {
        let language = value
            .split(['.', '@'])
            .next()
            .unwrap_or_default()
            .trim()
            .replace('_', "-");
        if language.eq_ignore_ascii_case("C")
            || language.eq_ignore_ascii_case("POSIX")
            || language.is_empty()
            || language.len() > 32
            || !language.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            })
        {
            continue;
        }
        if !languages
            .iter()
            .any(|known: &String| known.eq_ignore_ascii_case(&language))
        {
            languages.push(language);
        }
    }
    languages
}

pub(super) fn meeting_capture_app(value: &str) -> bool {
    let executable = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
    [
        "zoom",
        "zoom.us",
        "cpthost",
        "teams",
        "ms-teams",
        "microsoft teams",
        "webex",
        "ciscocollabhost",
        "skype",
        "discord",
        "chrome",
        "google chrome",
        "chromium",
        "chromium-browser",
        "firefox",
        "msedge",
        "microsoft edge",
        "brave",
        "brave-browser",
    ]
    .contains(&executable)
}

/// PulseAudio and PipeWire's PulseAudio compatibility service describe capture
/// streams. Playback and monitor sources are excluded. A browser microphone
/// stream is a meeting heuristic, just as WebRTC assertions are on macOS.
pub(super) fn pulse_meeting_status(outputs: &str, sources: &str) -> Option<bool> {
    let outputs = serde_json::from_str::<Vec<Value>>(outputs).ok()?;
    let sources = serde_json::from_str::<Vec<Value>>(sources).ok()?;
    for output in outputs {
        let source_id = output.get("source")?.as_u64()?;
        let source = sources
            .iter()
            .find(|source| source.get("index").and_then(Value::as_u64) == Some(source_id))?;
        let source_name = source.get("name")?.as_str()?;
        if source_name.ends_with(".monitor")
            || source
                .get("monitor_source")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty())
        {
            continue;
        }
        if output.get("corked").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let properties = output.get("properties")?.as_object()?;
        if ["application.process.binary", "application.name"]
            .iter()
            .filter_map(|name| properties.get(*name).and_then(Value::as_str))
            .any(meeting_capture_app)
        {
            return Some(true);
        }
    }
    Some(false)
}

pub(super) fn session_locked_hint(locked: Option<bool>, active: Option<bool>) -> Option<bool> {
    match (locked, active) {
        (Some(true), _) | (_, Some(false)) => Some(true),
        (Some(false), Some(true)) => Some(false),
        _ => None,
    }
}

pub(super) fn windows_idle_seconds(now: u32, last_input: u32) -> f64 {
    f64::from(now.wrapping_sub(last_input)) / 1000.
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_environment_strips_encodings_and_ignores_invalid_values() {
        assert_eq!(
            normalize_languages(
                [
                    "es_ES.UTF-8",
                    "en_US@latin",
                    "ES-es",
                    "C.UTF-8",
                    "POSIX",
                    "../es",
                    ""
                ]
                .map(String::from)
            ),
            ["es-ES", "en-US"]
        );
    }
    #[test]
    fn presence_never_confirms_missing_session_state() {
        assert_eq!(session_locked_hint(None, None), None);
        assert_eq!(session_locked_hint(Some(false), None), None);
        assert_eq!(session_locked_hint(None, Some(true)), None);
        assert_eq!(session_locked_hint(Some(false), Some(true)), Some(false));
        assert_eq!(session_locked_hint(Some(true), Some(true)), Some(true));
        assert_eq!(session_locked_hint(None, Some(false)), Some(true));
    }
    #[test]
    fn input_time_handles_windows_tick_wrap() {
        assert_eq!(windows_idle_seconds(1000, u32::MAX - 999), 2.);
        assert_eq!(windows_idle_seconds(3000, 2000), 1.);
    }
    #[test]
    fn pulse_capture_excludes_monitor_sources_and_inactive_streams() {
        let sources = r#"[{"index":1,"name":"alsa_input.microphone"},{"index":2,"name":"alsa_output.speaker.monitor"}]"#;
        let microphone =
            r#"[{"source":1,"corked":false,"properties":{"application.process.binary":"zoom"}}]"#;
        assert_eq!(pulse_meeting_status(microphone, sources), Some(true));
        assert_eq!(
            pulse_meeting_status(&microphone.replace("zoom", "audacity"), sources),
            Some(false)
        );
        assert_eq!(
            pulse_meeting_status(&microphone.replace("false", "true"), sources),
            Some(false)
        );
        assert_eq!(
            pulse_meeting_status(&microphone.replace("source\":1", "source\":2"), sources),
            Some(false)
        );
        assert_eq!(pulse_meeting_status("[]", sources), Some(false));
        let custom_monitor = r#"[{"index":1,"name":"custom_monitor","monitor_source":"speaker"}]"#;
        assert_eq!(
            pulse_meeting_status(microphone, custom_monitor),
            Some(false)
        );
        assert_eq!(pulse_meeting_status("not JSON", sources), None);
        assert_eq!(pulse_meeting_status(microphone, "[]"), None);
    }
    #[test]
    fn capture_process_identification_does_not_accept_similar_names() {
        assert!(meeting_capture_app(r"C:\\Program Files\\Zoom\\Zoom.exe"));
        assert!(meeting_capture_app("/usr/bin/chromium"));
        assert!(!meeting_capture_app("zoom-helper-unknown"));
        assert!(!meeting_capture_app("ffmpeg"));
    }
}
