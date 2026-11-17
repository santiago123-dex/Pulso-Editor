fn main() {
    // Recompilar cuando cambien los iconos para que el .exe lleve el logo actual.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
