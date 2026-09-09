// Fork-owned plan tests (DataTonic). Included from plan/mod.rs via #[path] so
// the test bodies live entirely in this fork-owned file and never touch
// upstream's src/plan/tests.rs. Reaches pub(crate) internals through `super::`
// (plan re-exports build_view_sql, NodeInputs; infor_* are module-scope here).

use super::{build_view_sql, infor_generic_url, infor_qenc, NodeInputs};
use serde_json::json;

// ---------------------------------------------------------------------------
// code.sqlstudio — a fork alias (Working DB's SQL Studio) that MUST stay wired
// to the same builder as code.sql. Nothing pins this today, so a re-route would
// pass CI silently. Mirrors upstream's regex_studio_nodes_build_identical_sql.
// ---------------------------------------------------------------------------
#[test]
fn sqlstudio_builds_identical_sql_to_code_sql() {
    let mut ni = NodeInputs::default();
    ni.ports.insert("main".into(), vec!["up".into()]);
    let props = json!({ "sql": "SELECT a, b FROM input WHERE a > 1" });

    let studio = build_view_sql("code.sqlstudio", &props, &ni, None, false).unwrap();
    let base = build_view_sql("code.sql", &props, &ni, None, false).unwrap();
    assert_eq!(
        studio, base,
        "code.sqlstudio must compile byte-identically to code.sql"
    );
}

// ---------------------------------------------------------------------------
// Infor _generic URL / query construction — the handoff's named backend gap.
// Break _lplFilter encoding or the query order and these fail instead of CI
// staying green.
// ---------------------------------------------------------------------------
#[test]
fn infor_qenc_ascii_is_unreserved_or_percent_escaped() {
    // Exhaustive over ASCII: the RFC 3986 unreserved set passes through, every
    // other byte becomes exactly %XX. This is the injection-safety contract.
    for c in 0u8..=127u8 {
        let ch = c as char;
        let enc = infor_qenc(&ch.to_string());
        let unreserved = ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~');
        if unreserved {
            assert_eq!(enc, ch.to_string(), "byte {c:#04x} should pass through");
        } else {
            assert_eq!(enc, format!("%{c:02X}"), "byte {c:#04x} should be %XX");
        }
    }
}

#[test]
fn infor_qenc_never_leaks_a_raw_query_delimiter() {
    let nasty = [
        "a&b", "a=b", "a b", "a\"b", "a#b", "a?b", "100%*", "l'été", "'; DROP", "x\n\ty",
    ];
    for s in nasty {
        let enc = infor_qenc(s);
        for bad in ['&', '=', ' ', '"', '#', '?', '\n', '\t', '*'] {
            assert!(
                !enc.contains(bad),
                "qenc({s:?}) = {enc:?} leaked delimiter {bad:?}"
            );
        }
    }
}

#[test]
fn infor_generic_url_orders_and_encodes_query_parts() {
    let url = infor_generic_url(
        "https://host/", // trailing slash trimmed
        "TENANT",
        "FSM",
        "fsm",
        "Item",
        Some("  Item,ItemGroup  "), // trimmed, comma -> %2C
        None,                       // _filter omitted
        Some("Item like \"100*\""), // spaces/quotes/star escaped
        Some("50"),
    );
    assert_eq!(
        url,
        "https://host/TENANT/FSM/fsm/soap/classes/Item/lists/_generic\
         ?_fields=Item%2CItemGroup&_lplFilter=Item%20like%20%22100%2A%22&_limit=50"
    );
}

#[test]
fn infor_generic_url_omits_blank_and_zero_parts() {
    // fields None, filter blank-after-trim, lpl None, limit "0" -> no query.
    let url = infor_generic_url(
        "https://h",
        "T",
        "FSM",
        "fsm",
        "Item",
        None,
        Some("   "),
        None,
        Some("0"),
    );
    assert_eq!(url, "https://h/T/FSM/fsm/soap/classes/Item/lists/_generic");
}
