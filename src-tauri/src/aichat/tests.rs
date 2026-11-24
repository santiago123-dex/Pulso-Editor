use super::*;

fn opts(mode: &str) -> ChatOptions {
    ChatOptions { session: None, model: None, effort: None, mode: mode.into() }
}

#[test]
fn lee_el_estado_de_la_sesion_sin_exponer_el_correo() {
    let t = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","orgName":"x","subscriptionType":"pro"}"#;
    assert_eq!(parse_auth_status(t), Some((true, "claude.ai".into(), "pro".into())));
    assert_eq!(parse_auth_status(r#"{"loggedIn":false}"#), Some((false, "".into(), "".into())));
    assert_eq!(parse_auth_status("no es json"), None);
    assert_eq!(parse_auth_status("{}"), None);
}

#[test]
fn argumentos_de_solo_lectura_y_de_edicion() {
    let r = build_claude_args(&opts("read")).unwrap();
    assert!(r.starts_with(&["-p".to_string(), "--output-format".to_string(), "stream-json".to_string()]));
    assert!(r.contains(&"--include-partial-messages".to_string()));
    let at = r.iter().position(|x| x == "--permission-mode").unwrap();
    assert_eq!(r[at + 1], "default");
    assert_eq!(r[r.iter().position(|x| x == "--allowedTools").unwrap() + 1], "Read,Glob,Grep");
    let e = build_claude_args(&opts("edit")).unwrap();
    assert_eq!(e[e.iter().position(|x| x == "--permission-mode").unwrap() + 1], "acceptEdits");
    assert!(e.iter().any(|x| x.contains("Edit") && x.contains("Write")));
    assert!(!e.iter().any(|x| x.contains("Bash")), "en modo edit no se permite ejecutar comandos");
    assert!(!e.iter().any(|x| x.contains("dangerously")));
    let f = build_claude_args(&opts("full")).unwrap();
    assert_eq!(f[f.iter().position(|x| x == "--permission-mode").unwrap() + 1], "acceptEdits");
    assert!(f.iter().any(|x| x.contains("Edit") && x.contains("Bash")), "en modo full se permite Bash");
}

#[test]
fn interpreta_modelos_y_uso_de_antigravity() {
    let txt = "Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\n";
    let m = parse_agy_models(txt);
    assert_eq!(m.len(), 2);
    assert_eq!(m[0].id, "gemini-4-hydrogen-high");
    assert_eq!(m[0].label, "Gemini 4 Hydrogen (High)");
    assert_eq!(m[0].note, "High");

    let usage_json = r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","description":"Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.82,"reset_time":"2026-11-25T15:17:00Z"}]}]}}}"#;
    let u = parse_agy_usage_json(usage_json).unwrap();
    assert_eq!(u.groups.len(), 1);
    assert_eq!(u.groups[0].name, "Gemini Models");
    assert!((u.groups[0].buckets[0].remaining_fraction - 0.82).abs() < 1e-6);
}

#[test]
fn interpreta_respuestas_de_codex_app_server() {
    let acc = serde_json::json!({"id":2,"result":{"account":{"type":"chatgpt","planType":"plus"}}});
    assert_eq!(parse_codex_app_account(&acc), (true, "chatgpt".into(), "plus".into()));

    let mods = serde_json::json!({"id":3,"result":{"data":[
        {"model":"gpt-6.2-sol","displayName":"GPT-6.2-Sol","description":"Fast","hidden":false},
        {"model":"gpt-5-old","displayName":"GPT-5 Old","description":"","hidden":true}
    ]}});
    let parsed = parse_codex_app_models(&mods);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].id, "gpt-6.2-sol");
    assert_eq!(parsed[1].note, "legacy");

    let rl = serde_json::json!({"id":4,"result":{"rateLimits":{"planType":"plus","primary":{"usedPercent":13,"resetsAt":1800000100},"secondary":{"usedPercent":58,"resetsAt":1800500000}}}});
    let q = parse_codex_app_rate_limits(&rl).unwrap();
    assert_eq!(q.plan, "plus");
    assert_eq!(q.five_hour.unwrap().used_percent, 13.0);
    assert_eq!(q.seven_day.unwrap().used_percent, 58.0);
}

#[test]
fn lee_el_texto_del_uso_del_plan() {
    let ok = r#"{"is_error":false,"result":"Current session: 68% used · resets Nov 18, 12pm (America/Bogota)"}"#;
    assert!(parse_usage_result(ok).unwrap().starts_with("Current session: 68%"));
    assert_eq!(parse_usage_result(r#"{"is_error":true,"result":"x"}"#), None);
    assert_eq!(parse_usage_result("no es json"), None);
}

#[test]
fn sesion_y_modelo_se_validan_y_se_pasan() {
    let o = ChatOptions {
        session: Some("3f1e2c1a-aaaa-bbbb-cccc-1234567890ab".into()),
        model: Some("sonnet".into()),
        effort: Some("high".into()),
        mode: "read".into(),
    };
    let a = build_claude_args(&o).unwrap();
    assert_eq!(a[a.iter().position(|x| x == "--resume").unwrap() + 1], "3f1e2c1a-aaaa-bbbb-cccc-1234567890ab");
    assert_eq!(a[a.iter().position(|x| x == "--model").unwrap() + 1], "sonnet");
    assert_eq!(a[a.iter().position(|x| x == "--effort").unwrap() + 1], "high");
    for malo in ["x; rm -rf /", "a b", "--help", "$(x)"] {
        assert!(build_claude_args(&ChatOptions { session: Some(malo.into()), model: None, effort: None, mode: "read".into() }).is_err(), "{malo}");
        assert!(build_claude_args(&ChatOptions { session: None, model: Some(malo.into()), effort: None, mode: "read".into() }).is_err(), "{malo}");
        assert!(build_claude_args(&ChatOptions { session: None, model: None, effort: Some(malo.into()), mode: "read".into() }).is_err(), "{malo}");
    }
    assert!(build_claude_args(&opts("todo")).is_err());
    assert!(!build_claude_args(&ChatOptions { session: None, model: Some("".into()), effort: Some("".into()), mode: "read".into() })
        .unwrap()
        .contains(&"--model".to_string()));
}

#[test]
fn el_proceso_recibe_el_mensaje_por_stdin_y_sus_lineas_llegan_en_orden() {
    let (program, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd", vec!["/C".into(), "more".into()]) } else { ("cat", vec![]) };
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let done = Arc::new(Mutex::new(None::<Option<i32>>));
    let (l2, d2) = (lines.clone(), done.clone());
    let cwd = std::env::temp_dir();
    spawn_stream(
        program,
        &args,
        &cwd.to_string_lossy(),
        "hola\nmundo\n",
        Arc::new(move |l| l2.lock().unwrap().push(l)),
        Arc::new(move |c, _| {
            *d2.lock().unwrap() = Some(c);
        }),
    )
    .unwrap();
    let t = Instant::now();
    while done.lock().unwrap().is_none() && t.elapsed().as_secs() < 15 {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(*done.lock().unwrap(), Some(Some(0)));
    let got: Vec<String> = lines.lock().unwrap().iter().map(|l| l.trim().to_string()).collect();
    assert_eq!(got, ["hola", "mundo"]);
}

#[test]
fn un_programa_que_no_existe_se_explica() {
    let err = spawn_stream("pulso-no-existe-xyz", &[], &std::env::temp_dir().to_string_lossy(), "x", Arc::new(|_| {}), Arc::new(|_, _| {})).unwrap_err();
    assert!(err.contains("No se pudo iniciar"), "{err}");
}

#[test]
fn interpreta_estado_de_codex_y_antigravity() {
    assert_eq!(parse_codex_login_status(true, "Logged in using ChatGPT"), (true, "chatgpt".into(), "ChatGPT".into()));
    assert_eq!(parse_codex_login_status(true, "Logged in using an API key - sk-..."), (true, "api_key".into(), "API".into()));
    assert_eq!(parse_codex_login_status(false, "Not logged in"), (false, "".into(), "".into()));

    assert_eq!(gemini_auth_from(None, true, false), (true, "api_key".into(), "API".into()));
    assert_eq!(gemini_auth_from(None, false, true), (true, "vertex".into(), "Vertex".into()));
    assert_eq!(gemini_auth_from(None, false, false), (false, "".into(), "".into()));

    let tmp = std::env::temp_dir().join(format!("pulso-ai-test-{}", std::process::id()));
    let gdir = tmp.join(".gemini");
    std::fs::create_dir_all(&gdir).unwrap();
    std::fs::write(gdir.join("google_accounts.json"), r#"{"active":"user@example.com"}"#).unwrap();
    assert_eq!(gemini_auth_from(Some(&tmp), false, false), (true, "google".into(), "Google".into()));

    std::fs::create_dir_all(tmp.join(".codex")).unwrap();
    std::fs::write(
        tmp.join(".codex").join("models_cache.json"),
        r#"{"models":[{"slug":"gpt-5.4","display_name":"GPT-5.4","visibility":"list"},{"slug":"hidden-1","visibility":"hide"}]}"#,
    )
    .unwrap();
    let codex_models = read_codex_models_from(Some(&tmp));
    assert_eq!(codex_models.len(), 1);
    assert_eq!(codex_models[0].id, "gpt-5.4");

    let sdir = tmp.join(".codex").join("sessions").join("2026").join("11").join("18");
    std::fs::create_dir_all(&sdir).unwrap();
    std::fs::write(
        sdir.join("rollout-1.jsonl"),
        r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"plan_type":"pro","primary":{"used_percent":35.0,"resets_at":1800000100},"secondary":{"used_percent":12.0,"resets_at":1800500000}}}}"#,
    ).unwrap();
    let cq = read_codex_quota_from(Some(&tmp)).unwrap();
    assert_eq!(cq.plan, "pro");
    assert_eq!(cq.five_hour.unwrap().used_percent, 35.0);
    assert_eq!(cq.seven_day.unwrap().used_percent, 12.0);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn argumentos_de_codex_y_antigravity() {
    let cr = build_codex_args(&ChatOptions { session: None, model: Some("gpt-6.2-sol".into()), effort: Some("max".into()), mode: "read".into() }).unwrap();
    assert_eq!(
        cr,
        ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--model", "gpt-6.2-sol", "-c", "model_reasoning_effort=\"xhigh\"", "-"]
    );
    let ce = build_codex_args(&ChatOptions {
        session: Some("thread_123".into()),
        model: Some("gpt-6.2-sol".into()),
        effort: Some("high".into()),
        mode: "edit".into(),
    })
    .unwrap();
    assert_eq!(
        ce,
        [
            "exec",
            "resume",
            "--json",
            "-c",
            "sandbox_mode=\"workspace-write\"",
            "--skip-git-repo-check",
            "--model",
            "gpt-6.2-sol",
            "-c",
            "model_reasoning_effort=\"high\"",
            "thread_123",
            "-"
        ]
    );
    let cf = build_codex_args(&ChatOptions { session: None, model: None, effort: None, mode: "full".into() }).unwrap();
    assert_eq!(cf, ["exec", "--json", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-"]);
    assert!(build_codex_args(&opts("bad")).is_err());

    let ar = build_agy_args(
        &ChatOptions { session: None, model: Some("gemini-4-hydrogen-high".into()), effort: Some("medium".into()), mode: "read".into() },
        "hola",
    )
    .unwrap();
    assert_eq!(&ar[..6], ["--output-format", "stream-json", "--mode", "plan", "--model", "gemini-4-hydrogen-high"]);
    assert_eq!(ar[6], "-p");
    assert!(ar[7].ends_with("hola") && ar[7].contains("Solo leer"));
    let ad = build_agy_args(&ChatOptions { session: None, model: None, effort: Some("high".into()), mode: "read".into() }, "hola").unwrap();
    assert_eq!(&ad[..6], ["--output-format", "stream-json", "--mode", "plan", "--effort", "high"]);
    let ae = build_agy_args(&ChatOptions { session: Some("conv-1".into()), model: None, effort: None, mode: "edit".into() }, "edita").unwrap();
    assert_eq!(&ae[..7], ["--output-format", "stream-json", "--mode", "accept-edits", "--conversation", "conv-1", "-p"]);
    assert!(ae[7].ends_with("edita") && ae[7].contains("Edición"));
    let af = build_agy_args(&ChatOptions { session: Some("conv-1".into()), model: None, effort: None, mode: "full".into() }, "ejecuta").unwrap();
    assert_eq!(&af[..6], ["--output-format", "stream-json", "--dangerously-skip-permissions", "--conversation", "conv-1", "-p"]);
    assert!(af[6].ends_with("ejecuta") && af[6].contains("Agente completo"));
}
