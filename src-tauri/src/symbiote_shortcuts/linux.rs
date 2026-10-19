//! Rendering for the separately owned Desktop launcher. The caller owns file
//! creation, byte-for-byte ownership checks, executable mode and atomic rename.

use std::path::Path;

/// Render a launcher for the real executable or outer AppImage, never its mount.
pub fn contents(target: &Path, icon: &Path, title: &str) -> Result<Vec<u8>, String> {
    let target = absolute_utf8(target, "Executable")?;
    let icon = absolute_utf8(icon, "Icon")?;
    validate_text(title, "Title")?;
    if title.trim().is_empty() {
        return Err("Title must not be empty".into());
    }
    // The Desktop Entry Exec grammar explicitly forbids '=' in the executable.
    if target.contains('=') {
        return Err("Executable path must not contain an equals sign".into());
    }
    let output = format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName={}\nExec={}\nIcon={}\nTerminal=false\nStartupWMClass=blincho\nCategories=Utility;Health;\n",
        value(title),
        executable(target),
        value(icon),
    );
    Ok(output.into_bytes())
}

fn validate_text(text: &str, label: &str) -> Result<(), String> {
    if text
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}'))
    {
        return Err(format!(
            "{label} must not contain control characters or line breaks"
        ));
    }
    Ok(())
}

fn absolute_utf8<'a>(path: &'a Path, label: &str) -> Result<&'a str, String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("{label} path must be valid UTF-8"))?;
    // This is the Linux path grammar even when its pure tests run on Windows.
    if !text.starts_with('/') {
        return Err(format!("{label} path must be absolute"));
    }
    validate_text(text, label)?;
    Ok(text)
}

// The general Desktop Entry string escaping is decoded before Exec quoting.
// Escape every ASCII space as well, preserving even leading/trailing Name spaces.
fn value(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            ' ' => escaped.push_str("\\s"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn executable(path: &str) -> String {
    let mut quoted = String::with_capacity(path.len() + 2);
    quoted.push('"');
    for ch in path.chars() {
        match ch {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(ch);
            }
            // No field codes are requested. Literal '%' survives their expansion.
            '%' => quoted.push_str("%%"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    value(&quoted)
}

/// Best effort and limited to the exact newly written, parent-owned launcher.
/// Some desktops still require a user action before launching a Desktop file.
#[cfg(target_os = "linux")]
pub fn trust(path: &Path) {
    use std::{
        fs, thread,
        time::{Duration, Instant},
    };

    if absolute_utf8(path, "Launcher").is_err()
        || path
            .extension()
            .is_none_or(|extension| extension != "desktop")
        || !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
    {
        return;
    }
    let Ok(mut child) = trust_command(path).spawn() else {
        return;
    };
    // GVfs can be unavailable. Do not leave a hung metadata helper or a zombie.
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Err(_) => break,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(any(target_os = "linux", test))]
fn trust_command(path: &Path) -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut command = Command::new("/usr/bin/gio");
    // -n also prevents following a final symlink swapped after the metadata check.
    command
        .args(["set", "-n", "-t", "string", "--"])
        .arg(path)
        .args(["metadata::trusted", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(target: &str, icon: &str, title: &str) -> String {
        String::from_utf8(contents(Path::new(target), Path::new(icon), title).unwrap()).unwrap()
    }

    fn field<'a>(entry: &'a str, name: &str) -> &'a str {
        let prefix = format!("{name}=");
        let mut matches = entry.lines().filter_map(|line| line.strip_prefix(&prefix));
        let found = matches.next().expect("required key missing");
        assert!(matches.next().is_none(), "duplicate key");
        found
    }

    // Independent decoder for the two specified parsing stages. It intentionally
    // accepts no unknown escapes or active field codes and permits one argument.
    fn decode_value(encoded: &str) -> String {
        let mut decoded = String::new();
        let mut chars = encoded.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                decoded.push(match chars.next().expect("incomplete value escape") {
                    '\\' => '\\',
                    's' => ' ',
                    _ => panic!("unexpected value escape"),
                });
            } else {
                decoded.push(ch);
            }
        }
        decoded
    }

    fn decode_exec(encoded: &str) -> String {
        let command = decode_value(encoded);
        assert!(command.starts_with('"') && command.ends_with('"'));
        let mut chars = command[1..command.len() - 1].chars();
        let mut result = String::new();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => {
                    let escaped = chars.next().expect("incomplete Exec escape");
                    assert!(matches!(escaped, '"' | '\\' | '$' | '`'));
                    result.push(escaped);
                }
                '%' => {
                    assert_eq!(chars.next(), Some('%'), "active field code");
                    result.push('%');
                }
                '"' | '$' | '`' => panic!("unescaped Exec metacharacter"),
                _ => result.push(ch),
            }
        }
        result
    }

    #[test]
    fn renders_the_complete_application_contract_without_extra_arguments() {
        let entry = render(
            "/opt/blincho",
            "/home/user/.local/share/blincho/63.png",
            "Blincho",
        );
        assert_eq!(entry, "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Blincho\nExec=\"/opt/blincho\"\nIcon=/home/user/.local/share/blincho/63.png\nTerminal=false\nStartupWMClass=blincho\nCategories=Utility;Health;\n");
        assert_eq!(decode_exec(field(&entry, "Exec")), "/opt/blincho");
    }

    #[test]
    fn preserves_spaces_in_paths_and_localized_title() {
        let target = "/home/a user/Applications/Blincho AppImage";
        let icon = "/home/a user/icon name.png ";
        let entry = render(target, icon, " Blincho  63 ");
        assert_eq!(decode_exec(field(&entry, "Exec")), target);
        assert_eq!(decode_value(field(&entry, "Name")), " Blincho  63 ");
        assert_eq!(decode_value(field(&entry, "Icon")), icon);
        assert!(field(&entry, "Exec").contains("a\\suser"));
    }

    #[test]
    fn applies_general_escaping_before_exec_quoting() {
        let target = "/opt/back\\slash\"quote`tick$dollar%literal";
        let entry = render(target, "/tmp/icon\\literal.png", "Blincho\\n");
        assert_eq!(
            field(&entry, "Exec"),
            r#""/opt/back\\\\slash\\"quote\\`tick\\$dollar%%literal""#
        );
        assert_eq!(decode_exec(field(&entry, "Exec")), target);
        assert_eq!(
            decode_value(field(&entry, "Icon")),
            "/tmp/icon\\literal.png"
        );
        assert_eq!(decode_value(field(&entry, "Name")), "Blincho\\n");
    }

    #[test]
    fn never_expands_percent_field_codes_in_the_executable() {
        let target = "/opt/%f%F%u%U%i%c%k%Z%%end%";
        let entry = render(target, "/tmp/%f.png", "Blincho %c");
        assert_eq!(
            field(&entry, "Exec"),
            "\"/opt/%%f%%F%%u%%U%%i%%c%%k%%Z%%%%end%%\""
        );
        assert_eq!(decode_exec(field(&entry, "Exec")), target);
        assert_eq!(field(&entry, "Icon"), "/tmp/%f.png");
        assert_eq!(decode_value(field(&entry, "Name")), "Blincho %c");
    }

    #[test]
    fn malicious_shell_syntax_remains_one_literal_executable() {
        let target = "/tmp/app\"; touch /tmp/no; $(touch /tmp/no) `touch /tmp/no` | cat & #x > y < z ' * ? ~";
        let entry = render(target, "/tmp/icon.png", "Blincho; $(touch /tmp/no)");
        assert_eq!(decode_exec(field(&entry, "Exec")), target);
        assert_eq!(entry.lines().count(), 9);
        assert_eq!(
            decode_value(field(&entry, "Name")),
            "Blincho; $(touch /tmp/no)"
        );
    }

    #[test]
    fn preserves_utf8_in_name_icon_and_executable() {
        let target = "/home/ユーザー/Блинчо.AppImage";
        let icon = "/home/用户/иконка 眼睛.png";
        let title = "Блинчо 👀 休憩 63";
        let entry = render(target, icon, title);
        assert_eq!(decode_exec(field(&entry, "Exec")), target);
        assert_eq!(decode_value(field(&entry, "Icon")), icon);
        assert_eq!(decode_value(field(&entry, "Name")), title);
    }

    #[test]
    fn rejects_control_characters_and_line_breaks_in_every_input() {
        for control in [
            '\0', '\n', '\r', '\t', '\u{1f}', '\u{7f}', '\u{85}', '\u{2028}', '\u{2029}',
        ] {
            let tainted = format!("/tmp/a{control}b");
            assert!(contents(Path::new(&tainted), Path::new("/tmp/i.png"), "Blincho").is_err());
            assert!(contents(Path::new("/tmp/app"), Path::new(&tainted), "Blincho").is_err());
            assert!(contents(Path::new("/tmp/app"), Path::new("/tmp/i.png"), &tainted).is_err());
        }
    }

    #[test]
    fn rejects_relative_paths_empty_titles_and_unrepresentable_executable() {
        for relative in ["", "blincho", "./blincho", "../blincho", "C:\\blincho.exe"] {
            assert!(contents(Path::new(relative), Path::new("/tmp/i.png"), "Blincho").is_err());
            assert!(contents(Path::new("/tmp/app"), Path::new(relative), "Blincho").is_err());
        }
        for title in ["", " ", "   "] {
            assert!(contents(Path::new("/tmp/app"), Path::new("/tmp/i.png"), title).is_err());
        }
        assert!(contents(Path::new("/tmp/a=b"), Path::new("/tmp/i.png"), "Blincho").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_utf8_paths_without_lossy_replacement() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt, path::PathBuf};
        let invalid = PathBuf::from(OsString::from_vec(vec![b'/', 0xff]));
        assert!(contents(&invalid, Path::new("/tmp/i.png"), "Blincho").is_err());
        assert!(contents(Path::new("/tmp/app"), &invalid, "Blincho").is_err());
    }

    #[test]
    fn trust_command_targets_only_the_explicit_file_without_a_shell() {
        let path = Path::new("/tmp/a `touch no`; $(touch no) %f.desktop");
        let command = trust_command(path);
        assert_eq!(command.get_program(), "/usr/bin/gio");
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(
            args,
            [
                "set",
                "-n",
                "-t",
                "string",
                "--",
                path.to_str().unwrap(),
                "metadata::trusted",
                "true"
            ]
        );
    }
}
