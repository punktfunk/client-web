// `build/pf-glue.js` is linked with `--js-library`, which cargo does not track. Naming it here makes
// a glue-only edit relink the module instead of shipping the previous glue.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_FAMILY").as_deref() == Ok("wasm") {
        println!("cargo:rerun-if-changed=build/pf-glue.js");
    }
}
