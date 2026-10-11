fn main() {
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    cc::Build::new().file("src/file_drag.m").flag("-fobjc-arc").flag("-fblocks").compile("termany_file_drag");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=CoreServices");
    println!("cargo:rerun-if-changed=src/file_drag.m");
  }
  tauri_build::build()
}
