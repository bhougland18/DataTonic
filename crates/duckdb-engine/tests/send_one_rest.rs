//! Integration coverage for the API Playground one-shot send (PL-11/12/13).
//!
//! A tiny in-process HTTP server answers canned responses so we can assert that
//! `send_one_rest`: applies auth from props, captures status + headers + body,
//! and returns a non-2xx as a normal result (not an error).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::thread;

use duckle_duckdb_engine::DuckdbEngine;
use serde_json::json;

// Spawn a mock server that handles a few sequential requests. A GET to
// `/notfound` answers 404; anything else answers 200 with a JSON body echoing
// whatever Authorization header arrived, plus a custom `X-Test` header.
fn spawn_mock() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        for _ in 0..8 {
            let Ok((mut stream, _)) = listener.accept() else { break };
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let auth = req
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                .map(|l| l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string())
                .unwrap_or_default();
            let (status_line, body) = if req.starts_with("GET /notfound") {
                ("HTTP/1.1 404 Not Found", "{\"error\":\"nope\"}".to_string())
            } else {
                ("HTTP/1.1 200 OK", format!("{{\"auth\":\"{auth}\"}}"))
            };
            let resp = format!(
                "{status_line}\r\nContent-Type: application/json\r\nX-Test: yes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://{addr}")
}

fn engine() -> DuckdbEngine {
    // The bin path is irrelevant: the send path never invokes DuckDB.
    DuckdbEngine::new(PathBuf::from("duckdb"))
}

fn no_proxy() {
    // Keep the localhost request off any ambient proxy.
    std::env::remove_var("HTTP_PROXY");
    std::env::remove_var("HTTPS_PROXY");
    std::env::remove_var("http_proxy");
    std::env::remove_var("https_proxy");
}

#[test]
fn ok_captures_status_headers_body_and_applies_bearer_auth() {
    no_proxy();
    let base = spawn_mock();
    let props = json!({
        "url": format!("{base}/thing"),
        "method": "GET",
        "authType": "bearer",
        "authToken": "tok123",
    });
    let res = engine().send_one_rest(&props).expect("send should succeed");
    assert_eq!(res["status"], 200, "status");
    // push_rest_auth turned authType/authToken into an Authorization: Bearer header.
    let body = res["body"].as_str().unwrap();
    assert!(body.contains("Bearer tok123"), "auth header reached server; body={body}");
    // Response headers are captured as [name, value] pairs.
    let headers = res["headers"].as_array().unwrap();
    assert!(
        headers
            .iter()
            .any(|p| p[0].as_str().unwrap().eq_ignore_ascii_case("x-test")),
        "x-test header captured",
    );
    assert!(res["elapsedMs"].is_number(), "timing recorded");
}

#[test]
fn non_2xx_is_returned_as_data_not_error() {
    no_proxy();
    let base = spawn_mock();
    let props = json!({ "url": format!("{base}/notfound"), "method": "GET" });
    let res = engine()
        .send_one_rest(&props)
        .expect("a 404 must be an Ok result, not an Err");
    assert_eq!(res["status"], 404);
    assert!(res["body"].as_str().unwrap().contains("nope"));
}

#[test]
fn missing_url_is_an_error() {
    let props = json!({ "method": "GET" });
    assert!(engine().send_one_rest(&props).is_err());
}
