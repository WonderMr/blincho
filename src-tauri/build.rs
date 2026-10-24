/// Compile macOS native bridges, link their system frameworks, and run Tauri build setup.
fn main() {
    println!("cargo:rerun-if-env-changed=BLINCHO_RELEASE_METADATA");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/macos.m")
            .file("native/notifications.m")
            .file("native/capture.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("blincho_macos");
        for framework in [
            "AppKit",
            "Foundation",
            "CoreGraphics",
            "UserNotifications",
            "CoreAudio",
            "CoreMediaIO",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=native/macos.m");
        println!("cargo:rerun-if-changed=native/notifications.m");
        println!("cargo:rerun-if-changed=native/capture.m");
    }
    tauri_build::build();
}
