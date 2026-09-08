//! A Parquet file goes through write-vortex and comes back out of read-vortex
//! with the same values.
//!
//! This is the only test the sidecar has, and it exists because compiling it
//! proves almost nothing. Taking vortex 0.75 -> 0.85 compiles cleanly once the
//! arrow bridge is repointed from `vortex::array::arrow` to `vortex::arrow`,
//! and then refuses to write anything: "Extension DType vortex.date not
//! permitted by enabled editions" with a date column, and "struct column writer
//! finished before all chunks were sent" without one. Nothing in the workspace
//! would have noticed, because src.vortex and snk.vortex are only exercised by
//! running them.
//!
//! So this drives the real binary through the real subcommands - the same two
//! the engine shells out to in connectors.rs - rather than calling the
//! conversion helpers directly. A test that reimplements the step it checks
//! would pass with the bug present.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use arrow_array::cast::AsArray;
use arrow_array::types::{Date32Type, Float64Type, Int64Type};
use arrow_array::{
    Array, BooleanArray, Date32Array, Float64Array, Int64Array, RecordBatch, StringArray,
};
use arrow_schema::{DataType, Field, Schema};

const ROWS: i64 = 1000;

/// The column types worth covering: an integer that will bitpack, a string that
/// will dictionary/FSST-compress, a float, a boolean, a date (an EXTENSION dtype,
/// which is exactly what 0.85 refused), and a column with nulls in it.
fn fixture() -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
        Field::new("score", DataType::Float64, false),
        Field::new("flag", DataType::Boolean, false),
        Field::new("d", DataType::Date32, false),
        Field::new("sparse", DataType::Int64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new((0..ROWS).collect::<Int64Array>()),
            Arc::new(
                (0..ROWS)
                    .map(|i| Some(format!("row_{i}")))
                    .collect::<StringArray>(),
            ),
            Arc::new((0..ROWS).map(|i| i as f64 * 1.5).collect::<Float64Array>()),
            Arc::new((0..ROWS).map(|i| Some(i % 2 == 0)).collect::<BooleanArray>()),
            Arc::new((0..ROWS).map(|i| Some(20454 + i as i32)).collect::<Date32Array>()),
            Arc::new(
                (0..ROWS)
                    .map(|i| if i % 7 == 0 { None } else { Some(i) })
                    .collect::<Int64Array>(),
            ),
        ],
    )
    .expect("build fixture batch")
}

fn write_parquet(path: &Path, batch: &RecordBatch) {
    let file = std::fs::File::create(path).expect("create parquet");
    let mut w = parquet::arrow::ArrowWriter::try_new(file, batch.schema(), None)
        .expect("parquet writer");
    w.write(batch).expect("write batch");
    w.close().expect("close parquet");
}

fn read_parquet(path: &Path) -> Vec<RecordBatch> {
    let file = std::fs::File::open(path).expect("open parquet");
    parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(file)
        .expect("parquet reader")
        .build()
        .expect("build reader")
        .collect::<Result<_, _>>()
        .expect("read parquet")
}

/// Run the sidecar and fail with its own stderr, which is where it puts the
/// message that says what actually went wrong.
fn run(args: &[&str]) {
    let out = Command::new(env!("CARGO_BIN_EXE_duckle-lance"))
        .args(args)
        .output()
        .expect("spawn duckle-lance");
    assert!(
        out.status.success(),
        "duckle-lance {} failed ({}): {}",
        args[0],
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    );
}

/// One cell as a comparable value. Every type the fixture uses is spelled out,
/// and an unexpected one panics rather than being skipped - a round trip that
/// turned a date into an integer must fail here, not pass quietly.
fn cell(col: &dyn Array, i: usize) -> Option<String> {
    if col.is_null(i) {
        return None;
    }
    Some(match col.data_type() {
        DataType::Int64 => col.as_primitive::<Int64Type>().value(i).to_string(),
        DataType::Float64 => col.as_primitive::<Float64Type>().value(i).to_string(),
        DataType::Boolean => col.as_boolean().value(i).to_string(),
        DataType::Date32 => col.as_primitive::<Date32Type>().value(i).to_string(),
        DataType::Utf8 => col.as_string::<i32>().value(i).to_string(),
        DataType::Utf8View => col.as_string_view().value(i).to_string(),
        other => panic!("round trip produced an unexpected type: {other:?}"),
    })
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("duckle-lance-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir.join(name)
}

#[test]
fn a_parquet_file_survives_a_vortex_round_trip_unchanged() {
    let src = scratch("src.parquet");
    let vx = scratch("out.vortex");
    let back = scratch("back.parquet");
    for p in [&src, &vx, &back] {
        let _ = std::fs::remove_file(p);
    }

    let batch = fixture();
    write_parquet(&src, &batch);

    run(&[
        "write-vortex",
        "--in",
        src.to_str().unwrap(),
        "--path",
        vx.to_str().unwrap(),
    ]);
    assert!(vx.exists(), "write-vortex reported success but wrote no file");

    run(&[
        "read-vortex",
        "--path",
        vx.to_str().unwrap(),
        "--out",
        back.to_str().unwrap(),
    ]);

    // Values, not just row counts: a round trip that loses the nulls or shifts
    // the dates would keep the count and still be wrong.
    //
    // Compared as values rather than as arrays, because the representation does
    // legitimately change: a Utf8 column comes back as Utf8View, vortex's
    // preferred Arrow type for strings. That is measured behaviour of the
    // sidecar as it stands, and it reaches DuckDB as VARCHAR either way. What
    // must not change is the content.
    let want = batch;
    let got = read_parquet(&back);
    let got_rows: usize = got.iter().map(|b| b.num_rows()).sum();
    assert_eq!(got_rows, ROWS as usize, "row count changed");

    let want_names: Vec<_> = want
        .schema()
        .fields()
        .iter()
        .map(|f| f.name().clone())
        .collect();
    for b in &got {
        let names: Vec<_> = b.schema().fields().iter().map(|f| f.name().clone()).collect();
        assert_eq!(names, want_names, "columns changed");
    }

    for (c, name) in want_names.iter().enumerate() {
        let expected: Vec<_> = (0..want.num_rows())
            .map(|i| cell(want.column(c).as_ref(), i))
            .collect();
        let mut actual = Vec::with_capacity(got_rows);
        for b in &got {
            for i in 0..b.num_rows() {
                actual.push(cell(b.column(c).as_ref(), i));
            }
        }
        assert_eq!(actual, expected, "column {name} came back different");
    }

    for p in [&src, &vx, &back] {
        let _ = std::fs::remove_file(p);
    }
}
