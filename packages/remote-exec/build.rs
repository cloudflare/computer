fn main() {
    println!("cargo:rerun-if-changed=schema/exec.capnp");
    capnpc::CompilerCommand::new()
        .src_prefix("schema")
        .file("schema/exec.capnp")
        .run()
        .expect("compiling schema/exec.capnp (is `capnp` installed?)");
}
