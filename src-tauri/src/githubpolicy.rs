//! Lista de solicitudes a la API de GitHub que Pulso permite hacer en nombre de la persona.
//!
//! El proxy `github_api` pone el token en cada solicitud. Si aceptara cualquier ruta y método, un script que
//! lograra ejecutarse en la ventana podría borrar repositorios o leer datos privados con el token. Aquí se
//! enumera lo que la interfaz usa de verdad (issues, etiquetas, pull requests, el chat del equipo, el usuario
//! y el borrado de una issue); todo lo demás se rechaza antes de salir de la máquina. La función es pura y se prueba.
use serde_json::Value;

/// Mutación GraphQL de «Eliminar issue». Es lo único que se permite por `/graphql` (la API REST no puede borrar issues).
const DELETE_ISSUE_QUERY: &str = "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }";

/// Tope del cuerpo de una solicitud: una issue o un comentario largos caben de sobra.
const MAX_BODY_BYTES: usize = 256 * 1024;

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_name(seg: &str) -> bool {
    !seg.is_empty() && seg.len() <= 100 && seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) && seg != "." && seg != ".."
}

fn is_number(seg: &str) -> bool {
    !seg.is_empty() && seg.len() <= 10 && seg.bytes().all(|b| b.is_ascii_digit())
}

/// Un segmento con codificación de URL (nombre de etiqueta, ruta de archivo, rango de comparación). Puede traer `%2F`,
/// pero nunca una barra real, una barra invertida, un control ni un punto o doble punto que reabra la ruta.
fn is_encoded_segment(seg: &str) -> bool {
    if seg.is_empty() || seg.len() > 600 || seg.contains('\\') || seg.chars().any(|c| c.is_control()) {
        return false;
    }
    let decoded = percent_decode(seg);
    decoded != "." && decoded != ".." && !seg.eq_ignore_ascii_case("%2e") && !seg.eq_ignore_ascii_case("%2e%2e")
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Comprueba método, ruta y cuerpo. `Ok(())` si la interfaz de Pulso puede hacerla.
pub fn check_request(method: &str, path: &str, body: Option<&str>) -> Result<(), ()> {
    if body.is_some_and(|b| b.len() > MAX_BODY_BYTES) {
        return Err(());
    }
    let path_only = path.split(['?', '#']).next().unwrap_or("");
    // La consulta (`?state=open&page=2`) no cambia el recurso, pero no debe traer saltos ni espacios sueltos.
    if path.chars().any(|c| c.is_control() || c == ' ') {
        return Err(());
    }
    let segs: Vec<&str> = path_only.trim_start_matches('/').split('/').collect();
    let ok = match (method, segs.as_slice()) {
        ("GET", ["user"]) => true,
        ("POST", ["graphql"]) => graphql_is_delete_issue(body),
        (m, ["repos", o, r, rest @ ..]) if is_name(o) && is_name(r) => repo_route(m, rest),
        _ => false,
    };
    // Los métodos con cuerpo deben traer JSON; los demás, nada.
    let body_ok = match method {
        "POST" | "PATCH" | "PUT" => body.is_none_or(|b| serde_json::from_str::<Value>(b).is_ok()),
        _ => body.is_none(),
    };
    if ok && body_ok && body_shape_ok(method, &segs, body) { Ok(()) } else { Err(()) }
}

/// Fusionar y revisar solo admiten los campos que usa el panel, con valores conocidos: nada de `sha` ajeno ni de eventos raros.
fn body_shape_ok(method: &str, segs: &[&str], body: Option<&str>) -> bool {
    let kind = match (method, segs) {
        ("PUT", ["repos", _, _, "pulls", _, "merge"]) => "merge",
        ("POST", ["repos", _, _, "pulls", _, "reviews"]) => "review",
        _ => return true,
    };
    let Some(v) = body.and_then(|b| serde_json::from_str::<Value>(b).ok()) else { return false };
    let Some(obj) = v.as_object() else { return false };
    let (allowed, enum_key, enum_values): (&[&str], &str, &[&str]) = if kind == "merge" {
        (&["merge_method", "commit_title", "commit_message"], "merge_method", &["merge", "squash", "rebase"])
    } else {
        (&["event", "body"], "event", &["COMMENT", "APPROVE", "REQUEST_CHANGES"])
    };
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) || obj.values().any(|x| !x.is_string()) {
        return false;
    }
    match obj.get(enum_key).and_then(Value::as_str) {
        Some(x) => enum_values.contains(&x),
        None => kind == "merge", // fusionar sin método usa el de GitHub; una revisión necesita su `event`
    }
}

fn repo_route(method: &str, rest: &[&str]) -> bool {
    match (method, rest) {
        // Lectura
        ("GET", []) => true,
        ("GET", ["issues"]) => true,
        ("GET", ["issues", n]) => is_number(n),
        ("GET", ["issues", n, "comments"]) => is_number(n),
        ("GET", ["labels", name]) => is_encoded_segment(name),
        ("GET", ["pulls"]) => true,
        ("GET", ["pulls", n]) => is_number(n),
        ("GET", ["pulls", n, "files"]) => is_number(n),
        ("GET", ["compare", spec]) => is_encoded_segment(spec),
        ("GET", ["commits", sha, "check-runs"]) => is_encoded_segment(sha),
        ("GET", ["collaborators"]) | ("GET", ["contributors"]) => true,
        ("GET", ["contents", path @ ..]) => !path.is_empty() && path.iter().all(|s| is_encoded_segment(s)),
        // Escritura
        ("POST", ["issues"]) => true,
        ("PATCH", ["issues", n]) => is_number(n),
        ("POST", ["issues", n, "labels"]) => is_number(n),
        ("DELETE", ["issues", n, "labels", name]) => is_number(n) && is_encoded_segment(name),
        ("POST", ["issues", n, "comments"]) => is_number(n),
        ("POST", ["labels"]) => true,
        ("POST", ["pulls"]) => true,
        // Fusionar y revisar una pull request: lo ofrece el panel de pull requests, con cuerpo acotado (ver `body_shape_ok`).
        ("PUT", ["pulls", n, "merge"]) => is_number(n),
        ("POST", ["pulls", n, "reviews"]) => is_number(n),
        _ => false,
    }
}

/// `/graphql` solo para borrar una issue: la consulta tiene que ser exactamente esa mutación y las variables, solo `id`.
fn graphql_is_delete_issue(body: Option<&str>) -> bool {
    let Some(v) = body.and_then(|b| serde_json::from_str::<Value>(b).ok()) else { return false };
    let Some(obj) = v.as_object() else { return false };
    if obj.keys().any(|k| k != "query" && k != "variables") {
        return false;
    }
    let query_ok = obj.get("query").and_then(Value::as_str).is_some_and(|q| collapse_ws(q) == collapse_ws(DELETE_ISSUE_QUERY));
    let vars_ok = obj.get("variables").and_then(Value::as_object).is_some_and(|m| m.len() == 1 && m.get("id").is_some_and(Value::is_string));
    query_ok && vars_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(m: &str, p: &str, b: Option<&str>) -> bool { check_request(m, p, b).is_ok() }

    #[test]
    fn permite_lo_que_usa_la_interfaz() {
        assert!(ok("GET", "/user", None));
        assert!(ok("GET", "/repos/ana/app", None));
        assert!(ok("GET", "/repos/ana/app/issues?state=open&per_page=50&page=2&sort=updated&direction=desc", None));
        assert!(ok("GET", "/repos/ana/app/issues/12", None));
        assert!(ok("GET", "/repos/ana/app/issues/12/comments?per_page=100&since=2026-11-22T10%3A00%3A00Z", None));
        assert!(ok("GET", "/repos/ana/app/labels/pulso%3A%20in%20review", None));
        assert!(ok("GET", "/repos/ana/app/pulls?state=open", None));
        assert!(ok("GET", "/repos/ana/app/pulls/3/files?per_page=100&page=1", None));
        assert!(ok("GET", "/repos/ana/app/compare/abc123...def456?per_page=1", None));
        assert!(ok("GET", "/repos/ana/app/contents/src/main.ts?ref=main", None));
        assert!(ok("GET", "/repos/ana/app/collaborators?per_page=100", None));
        assert!(ok("POST", "/repos/ana/app/issues", Some(r#"{"title":"x"}"#)));
        assert!(ok("PATCH", "/repos/ana/app/issues/5", Some(r#"{"state":"closed"}"#)));
        assert!(ok("POST", "/repos/ana/app/issues/5/labels", Some(r#"{"labels":["a"]}"#)));
        assert!(ok("DELETE", "/repos/ana/app/issues/5/labels/pulso%3A%20done", None));
        assert!(ok("POST", "/repos/ana/app/issues/5/comments", Some(r#"{"body":"hola"}"#)));
        assert!(ok("POST", "/repos/ana/app/labels", Some(r#"{"name":"x","color":"fff"}"#)));
        assert!(ok("POST", "/repos/ana/app/pulls", Some(r#"{"title":"x","head":"a","base":"main"}"#)));
        // Panel de pull requests: fusionar, revisar y ver las comprobaciones.
        assert!(ok("PUT", "/repos/ana/app/pulls/3/merge", Some(r#"{"merge_method":"squash","commit_title":"Arregla x"}"#)));
        assert!(ok("PUT", "/repos/ana/app/pulls/3/merge", Some("{}")));
        assert!(ok("POST", "/repos/ana/app/pulls/3/reviews", Some(r#"{"event":"APPROVE","body":"bien"}"#)));
        assert!(ok("POST", "/repos/ana/app/pulls/3/reviews", Some(r#"{"event":"REQUEST_CHANGES","body":"revisa esto"}"#)));
        assert!(ok("GET", "/repos/ana/app/commits/0123abc/check-runs?per_page=50", None));
    }

    #[test]
    fn rechaza_lo_destructivo_o_ajeno() {
        // Borrar o transferir un repositorio, cambiar su visibilidad, tocar claves o webhooks.
        assert!(!ok("DELETE", "/repos/ana/app", None));
        assert!(!ok("PATCH", "/repos/ana/app", Some(r#"{"private":false}"#)));
        assert!(!ok("POST", "/repos/ana/app/transfer", Some("{}")));
        assert!(!ok("GET", "/repos/ana/app/keys", None));
        assert!(!ok("POST", "/repos/ana/app/hooks", Some("{}")));
        assert!(!ok("PUT", "/repos/ana/app/collaborators/mala", Some("{}")));
        assert!(!ok("DELETE", "/repos/ana/app/issues/5", None));
        assert!(!ok("PUT", "/repos/ana/app/pulls/x/merge", Some("{}")));
        assert!(!ok("PUT", "/repos/ana/app/pulls/3/merge", None));
        assert!(!ok("PUT", "/repos/ana/app/pulls/3/merge", Some(r#"{"merge_method":"force"}"#)));
        assert!(!ok("PUT", "/repos/ana/app/pulls/3/merge", Some(r#"{"merge_method":"squash","sha":"abc"}"#)));
        assert!(!ok("POST", "/repos/ana/app/pulls/3/reviews", Some(r#"{"body":"sin evento"}"#)));
        assert!(!ok("POST", "/repos/ana/app/pulls/3/reviews", Some(r#"{"event":"DISMISS","body":"x"}"#)));
        assert!(!ok("PUT", "/repos/ana/app/pulls/3/reviews/9/dismissals", Some("{}")));
        assert!(!ok("GET", "/repos/ana/app/commits/abc/statuses", None));
        // Cosas de la cuenta y de otras organizaciones.
        assert!(!ok("GET", "/user/repos", None));
        assert!(!ok("DELETE", "/user", None));
        assert!(!ok("GET", "/orgs/x/repos", None));
        assert!(!ok("GET", "/notifications", None));
        assert!(!ok("GET", "/search/code?q=password", None));
        assert!(!ok("GET", "/gists", None));
        assert!(!ok("GET", "/", None));
        assert!(!ok("GET", "", None));
    }

    #[test]
    fn rechaza_rutas_trucadas() {
        assert!(!ok("GET", "/repos/ana/app/issues/../../../user/repos", None));
        assert!(!ok("GET", "/repos/ana/app/contents/%2e%2e/%2e%2e/x", None));
        assert!(!ok("GET", "/repos/ana/app/contents/a/../b", None));
        assert!(!ok("GET", "/repos/ana/../mala/issues", None));
        assert!(!ok("GET", "/repos/an a/app/issues", None));
        assert!(!ok("GET", "/repos/ana/app/issues/1x", None));
        assert!(!ok("GET", "/repos/ana/app/issues/12/comments\r\nX: y", None));
        assert!(!ok("GET", "//evil.test/repos/ana/app", None));
        assert!(!ok("GET", "/repos/ana/app/labels/a\\b", None));
        assert!(!ok("get", "/user", None)); // el método va en mayúsculas
    }

    #[test]
    fn el_cuerpo_se_vigila() {
        assert!(!ok("POST", "/repos/ana/app/issues", Some("esto no es json")));
        assert!(!ok("GET", "/repos/ana/app/issues", Some("{}")));
        let grande = format!(r#"{{"body":"{}"}}"#, "a".repeat(MAX_BODY_BYTES));
        assert!(!ok("POST", "/repos/ana/app/issues", Some(&grande)));
    }

    #[test]
    fn graphql_solo_para_borrar_una_issue() {
        let bien = r#"{"query":"mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }","variables":{"id":"I_abc"}}"#;
        assert!(ok("POST", "/graphql", Some(bien)));
        // Espacios distintos no importan.
        let otros_espacios = r#"{"query":"mutation($id: ID!) {\n  deleteIssue(input: { issueId: $id }) {\n clientMutationId } }","variables":{"id":"I_abc"}}"#;
        assert!(ok("POST", "/graphql", Some(otros_espacios)));
        // Otra consulta, otra mutación, variables de más o sin cuerpo: no.
        assert!(!ok("POST", "/graphql", Some(r#"{"query":"{ viewer { login } }"}"#)));
        assert!(!ok("POST", "/graphql", Some(r#"{"query":"mutation { deleteRepository(input:{repositoryId:\"x\"}) { clientMutationId } }"}"#)));
        assert!(!ok("POST", "/graphql", Some(r#"{"query":"mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }","variables":{"id":"I_abc","otra":1}}"#)));
        assert!(!ok("POST", "/graphql", Some(r#"{"query":"mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }","operationName":"x","variables":{"id":"I_abc"}}"#)));
        assert!(!ok("POST", "/graphql", None));
        assert!(!ok("GET", "/graphql", None));
    }
}
