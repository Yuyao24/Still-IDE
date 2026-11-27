//! The database panel: SQLite files in the project and Postgres servers. It lists tables and
//! their columns and runs queries, returning rows as text for the grid. Postgres passwords are
//! kept in the system's credential store, never in Still's settings.
use crate::workspace::{relative, root, Result};
use serde::{Deserialize, Serialize};
use std::{str::FromStr, sync::Arc, time::{Duration, Instant}};

fn err(error: impl std::fmt::Display) -> String { error.to_string() }

const SERVICE: &str = "dev.still.editor";
const MAX_ROWS: usize = 2000;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbConn {
    kind: String,
    /// SQLite: the file, relative to the project.
    path: Option<String>,
    root_path: Option<String>,
    /// Postgres: a postgres:// URL (no password; that comes from the credential store).
    url: Option<String>,
    /// Where the password is kept in the credential store.
    key: Option<String>,
}

#[derive(Serialize, Default)]
pub struct DbColumn { name: String, #[serde(rename = "type")] kind: String, key: bool }

#[derive(Serialize, Default)]
pub struct DbTable { schema: String, name: String, view: bool, columns: Vec<DbColumn> }

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    /// Rows changed by the last statement that wasn't a query.
    changed: Option<u64>,
    truncated: bool,
    millis: u64,
    statements: usize,
}

fn password_entry(key: &str) -> Result<keyring::Entry> { keyring::Entry::new(SERVICE, &format!("db-{key}")).map_err(err) }

/// Passwords for this session only, when the system keychain can't be used.
static SESSION_PASSWORDS: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> = std::sync::Mutex::new(None);

/// Keeps a password in the system keychain; if there isn't one that works, for this session only.
/// Returns where it went: "keychain" or "session".
#[tauri::command]
pub fn db_save_password(key: String, password: String) -> Result<String> {
    if password_entry(&key).and_then(|entry| entry.set_password(&password).map_err(err)).is_ok() { return Ok("keychain".into()) }
    SESSION_PASSWORDS.lock().map_err(err)?.get_or_insert_with(Default::default).insert(key, password);
    Ok("session".into())
}

#[tauri::command]
pub fn db_forget_password(key: String) -> Result<()> {
    if let Ok(mut map) = SESSION_PASSWORDS.lock() { if let Some(map) = map.as_mut() { map.remove(&key); } }
    match password_entry(&key)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(error) => Err(err(error)) }
}

fn saved_password(key: &str) -> Option<String> {
    if let Some(password) = SESSION_PASSWORDS.lock().ok().and_then(|map| map.as_ref().and_then(|map| map.get(key).cloned())) { return Some(password) }
    password_entry(key).ok()?.get_password().ok()
}

// ---- SQLite ----
fn sqlite(conn: &DbConn) -> Result<rusqlite::Connection> {
    let cwd = root(conn.root_path.as_deref().ok_or("No project folder.")?)?;
    let path = cwd.join(relative(conn.path.as_deref().ok_or("No database file.")?)?);
    if !path.is_file() { return Err(format!("{} isn't there any more.", conn.path.as_deref().unwrap_or(""))) }
    // Open what's there; never create an empty database by accident.
    let db = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(err)?;
    db.busy_timeout(Duration::from_secs(4)).map_err(err)?;
    Ok(db)
}

fn sqlite_text(value: rusqlite::types::ValueRef) -> Option<String> {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => None,
        ValueRef::Integer(number) => Some(number.to_string()),
        // 2.0, not 2, so a REAL reads as one (as sqlite3 prints it).
        ValueRef::Real(number) => Some(if number.is_finite() && number.fract() == 0.0 && number.abs() < 1e15 { format!("{number:.1}") } else { number.to_string() }),
        ValueRef::Text(text) => Some(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => Some(format!("<{} bytes>", bytes.len())),
    }
}

fn sqlite_tables(db: &rusqlite::Connection) -> Result<Vec<DbTable>> {
    let mut statement = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").map_err(err)?;
    let names: Vec<(String, String)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(err)?.flatten().collect();
    let mut tables = Vec::new();
    for (name, kind) in names {
        let mut info = db.prepare(&format!("PRAGMA table_info(\"{}\")", name.replace('"', "\"\""))).map_err(err)?;
        let columns = info.query_map([], |row| Ok(DbColumn { name: row.get(1)?, kind: row.get::<_, String>(2).unwrap_or_default(), key: row.get::<_, i64>(5).unwrap_or(0) > 0 })).map_err(err)?.flatten().collect();
        tables.push(DbTable { schema: String::new(), name, view: kind == "view", columns });
    }
    Ok(tables)
}

/// Splits SQL into statements at semicolons outside quotes and comments.
fn statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut index = 0;
    let mut quote: Option<char> = None;
    while index < chars.len() {
        let char = chars[index];
        if let Some(open) = quote {
            current.push(char);
            if char == open { quote = None }
        } else if char == '\'' || char == '"' || char == '`' { quote = Some(char); current.push(char) }
        else if char == '-' && chars.get(index + 1) == Some(&'-') { while index < chars.len() && chars[index] != '\n' { index += 1 } continue }
        else if char == '/' && chars.get(index + 1) == Some(&'*') { index += 2; while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') { index += 1 } index += 2; continue }
        else if char == ';' { if !current.trim().is_empty() { out.push(current.trim().to_owned()) } current.clear() }
        else { current.push(char) }
        index += 1;
    }
    if !current.trim().is_empty() { out.push(current.trim().to_owned()) }
    out
}

fn sqlite_query(db: &rusqlite::Connection, sql: &str) -> Result<DbResult> {
    let started = Instant::now();
    let list = statements(sql);
    if list.is_empty() { return Err("There's no SQL to run.".into()) }
    let mut result = DbResult { statements: list.len(), ..Default::default() };
    for (index, text) in list.iter().enumerate() {
        let mut statement = db.prepare(text).map_err(|error| if list.len() > 1 { format!("Statement {}: {error}", index + 1) } else { err(error) })?;
        if statement.column_count() > 0 {
            let columns: Vec<String> = statement.column_names().into_iter().map(String::from).collect();
            let count = columns.len();
            let mut rows = statement.query([]).map_err(err)?;
            let mut collected = Vec::new();
            let mut truncated = false;
            while let Some(row) = rows.next().map_err(err)? {
                if collected.len() >= MAX_ROWS { truncated = true; break }
                collected.push((0..count).map(|column| row.get_ref(column).map(sqlite_text).unwrap_or(None)).collect());
            }
            result.columns = columns; result.rows = collected; result.truncated = truncated; result.changed = None;
        } else {
            let changed = statement.execute([]).map_err(err)?;
            result.changed = Some(changed as u64);
            result.columns.clear(); result.rows.clear();
        }
    }
    result.millis = started.elapsed().as_millis() as u64;
    Ok(result)
}

// ---- Postgres ----
#[derive(Debug)]
struct AnyCert(Arc<rustls::crypto::CryptoProvider>);
impl rustls::client::danger::ServerCertVerifier for AnyCert {
    fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &rustls::pki_types::CertificateDer<'_>, dss: &rustls::DigitallySignedStruct) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &rustls::pki_types::CertificateDer<'_>, dss: &rustls::DigitallySignedStruct) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> { self.0.signature_verification_algorithms.supported_schemes() }
}

/// Connects the way libpq does: sslmode=require encrypts without checking the certificate
/// (as psql does); verify-ca and verify-full check it against the usual public roots.
fn postgres(conn: &DbConn) -> Result<postgres::Client> {
    let url = conn.url.as_deref().ok_or("No server address.")?;
    let (base, query) = url.split_once('?').unwrap_or((url, ""));
    let mut strict = false;
    let params: Vec<String> = query.split('&').filter(|pair| !pair.is_empty()).filter_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "sslmode" && (value == "verify-ca" || value == "verify-full") { strict = true; return Some("sslmode=require".into()) }
        Some(pair.to_owned())
    }).collect();
    let cleaned = if params.is_empty() { base.to_owned() } else { format!("{base}?{}", params.join("&")) };
    let mut config = postgres::Config::from_str(&cleaned).map_err(|error| format!("That address doesn't look right: {error}"))?;
    config.connect_timeout(Duration::from_secs(8));
    if config.get_password().is_none() {
        if let Some(password) = conn.key.as_deref().and_then(saved_password) { config.password(password); }
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().map_err(err)?;
    let tls = if strict {
        builder.with_root_certificates(rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() }).with_no_client_auth()
    } else {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(AnyCert(provider))).with_no_client_auth()
    };
    config.connect(tokio_postgres_rustls::MakeRustlsConnect::new(tls)).map_err(|error| {
        let text = error.to_string();
        let detail = std::error::Error::source(&error).map(|source| source.to_string()).unwrap_or_default();
        if text.contains("password") || detail.contains("password") { format!("The server refused the login: {}", if detail.is_empty() { text } else { detail }) }
        else { format!("Couldn't connect: {}", if detail.is_empty() { text } else { detail }) }
    })
}

fn postgres_query(client: &mut postgres::Client, sql: &str) -> Result<DbResult> {
    let started = Instant::now();
    let messages = client.simple_query(sql).map_err(|error| std::error::Error::source(&error).map(|source| source.to_string()).unwrap_or_else(|| error.to_string()))?;
    let mut result = DbResult::default();
    let mut current: Vec<Vec<Option<String>>> = Vec::new();
    let mut columns: Vec<String> = Vec::new();
    for message in messages {
        match message {
            postgres::SimpleQueryMessage::RowDescription(description) => { columns = description.iter().map(|column| column.name().to_owned()).collect(); current.clear() }
            postgres::SimpleQueryMessage::Row(row) => {
                if columns.is_empty() { columns = row.columns().iter().map(|column| column.name().to_owned()).collect() }
                if current.len() >= MAX_ROWS { result.truncated = true; continue }
                current.push((0..row.len()).map(|index| row.get(index).map(String::from)).collect());
            }
            postgres::SimpleQueryMessage::CommandComplete(count) => {
                result.statements += 1;
                if columns.is_empty() { result.changed = Some(count); result.columns.clear(); result.rows.clear() }
                else { result.columns = std::mem::take(&mut columns); result.rows = std::mem::take(&mut current); result.changed = None }
            }
            _ => {}
        }
    }
    result.millis = started.elapsed().as_millis() as u64;
    Ok(result)
}

fn postgres_tables(client: &mut postgres::Client) -> Result<Vec<DbTable>> {
    let sql = "SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, \
        EXISTS (SELECT 1 FROM information_schema.table_constraints k JOIN information_schema.key_column_usage u ON k.constraint_name = u.constraint_name AND k.table_schema = u.table_schema \
          WHERE k.constraint_type = 'PRIMARY KEY' AND u.table_schema = c.table_schema AND u.table_name = c.table_name AND u.column_name = c.column_name) \
        FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY c.table_schema, c.table_name, c.ordinal_position";
    let result = postgres_query(client, sql)?;
    let mut tables: Vec<DbTable> = Vec::new();
    for row in result.rows {
        let text = |index: usize| row.get(index).cloned().flatten().unwrap_or_default();
        let (schema, name) = (text(0), text(1));
        if tables.last().is_none_or(|table| table.schema != schema || table.name != name) {
            tables.push(DbTable { schema: schema.clone(), name: name.clone(), view: text(2) == "VIEW", columns: Vec::new() });
        }
        tables.last_mut().unwrap().columns.push(DbColumn { name: text(3), kind: text(4), key: text(5) == "t" });
    }
    Ok(tables)
}

#[tauri::command]
pub async fn db_tables(conn: DbConn) -> Result<Vec<DbTable>> {
    tauri::async_runtime::spawn_blocking(move || match conn.kind.as_str() {
        "sqlite" => sqlite_tables(&sqlite(&conn)?),
        "postgres" => postgres_tables(&mut postgres(&conn)?),
        _ => Err("Unknown kind of database.".into()),
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn db_query(conn: DbConn, sql: String) -> Result<DbResult> {
    tauri::async_runtime::spawn_blocking(move || match conn.kind.as_str() {
        "sqlite" => sqlite_query(&sqlite(&conn)?, &sql),
        "postgres" => postgres_query(&mut postgres(&conn)?, &sql),
        _ => Err("Unknown kind of database.".into()),
    }).await.map_err(err)?
}

#[cfg(test)]
mod check {
    #[test]
    fn splits_statements() {
        let list = super::statements("select ';' as a; -- note; here\ninsert into t values (1);/* x; */ select 2");
        assert_eq!(list, vec!["select ';' as a", "insert into t values (1)", "select 2"]);
    }

    #[test]
    fn runs_sqlite() {
        let db = rusqlite::Connection::open_in_memory().expect("memory db");
        db.execute_batch("create table items (id integer primary key, name text, price real); insert into items (name, price) values ('pen', 1.5), ('ink', null);").expect("setup");
        let tables = super::sqlite_tables(&db).expect("tables");
        assert_eq!(tables[0].name, "items");
        assert!(tables[0].columns[0].key);
        let result = super::sqlite_query(&db, "update items set price = 2 where name = 'pen'; select name, price from items order by id").expect("query");
        assert_eq!(result.columns, vec!["name", "price"]);
        assert_eq!(result.rows[0], vec![Some("pen".into()), Some("2.0".into())]);
        assert_eq!(result.rows[1][1], None);
        assert_eq!(result.statements, 2);
    }
}
