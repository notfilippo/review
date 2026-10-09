use std::convert::Infallible;
use std::net::SocketAddr;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::stream;
use getrandom::fill;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc};

use crate::cli::CliOptions;
use crate::frontend;
use crate::search::{SearchCorpus, SearchRequest};
use crate::vcs::{ReviewComment, ReviewFile, ReviewInput, normalize_comments};

const TOKEN_BYTES: usize = 16;
const SEARCH_EVENT_BUFFER: usize = 256;

struct ReviewSession {
    token: String,
    input: ReviewInput,
    corpus: Arc<SearchCorpus>,
    comments: Arc<Mutex<Vec<ReviewComment>>>,
    done: Arc<Notify>,
    completed: Arc<AtomicBool>,
}

#[derive(Serialize)]
struct SessionResponse<'a> {
    files: &'a [ReviewFile],
    comments: Vec<ReviewComment>,
}

#[derive(Deserialize)]
struct CommentsRequest {
    comments: Vec<ReviewComment>,
}

#[derive(Deserialize)]
struct AuthQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

pub async fn serve_review(
    options: &CliOptions,
    input: ReviewInput,
    corpus: SearchCorpus,
) -> Result<Vec<ReviewComment>> {
    let token = new_token().context("create review token")?;
    let session = Arc::new(ReviewSession {
        token,
        input,
        corpus: Arc::new(corpus),
        comments: Arc::new(Mutex::new(Vec::new())),
        done: Arc::new(Notify::new()),
        completed: Arc::new(AtomicBool::new(false)),
    });

    let listener = bind_listener(options).await?;
    let addr = listener.local_addr().context("read listener address")?;
    let url = format!("http://{addr}/?token={}", session.token);
    eprintln!("Review UI: {url}");
    if let Err(err) = open_browser(&url) {
        eprintln!("Could not open browser: {err}");
    }

    let shutdown = Arc::new(Notify::new());
    let app = routes(session.clone());
    let server_shutdown = shutdown.clone();
    let mut server_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                server_shutdown.notified().await;
            })
            .await
    });

    tokio::select! {
        () = session.done.notified() => {}
        result = tokio::signal::ctrl_c() => {
            shutdown.notify_waiters();
            result.context("wait for ctrl-c")?;
            bail!("review cancelled");
        }
        result = &mut server_task => {
            match result {
                Ok(Ok(())) => bail!("server stopped before review completed"),
                Ok(Err(err)) => return Err(err).context("serve review UI"),
                Err(err) => return Err(err).context("join review UI server"),
            }
        }
    }

    shutdown.notify_waiters();
    match server_task.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(err).context("serve review UI"),
        Err(err) => return Err(err).context("join review UI server"),
    }
    Ok(session.comments_snapshot())
}

fn routes(session: Arc<ReviewSession>) -> Router {
    Router::new()
        .route("/api/session", get(handle_session))
        .route("/api/comments", put(handle_comments))
        .route("/api/search", get(handle_search))
        .route("/api/file", get(handle_file))
        .route("/api/complete", post(handle_complete))
        .fallback(static_asset)
        .with_state(session)
}

async fn bind_listener(options: &CliOptions) -> Result<TcpListener> {
    match TcpListener::bind(options.listen_addr).await {
        Ok(listener) => Ok(listener),
        Err(err) if options.allow_port_fallback => {
            TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
                .await
                .with_context(|| format!("bind fallback listener after {err}"))
        }
        Err(err) => Err(err).with_context(|| format!("bind {}", options.listen_addr)),
    }
}

async fn handle_session(
    State(session): State<Arc<ReviewSession>>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !session.authorized(&headers, query.token.as_deref()) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    Json(SessionResponse {
        files: &session.input.files,
        comments: session.comments_snapshot(),
    })
    .into_response()
}

async fn handle_search(
    State(session): State<Arc<ReviewSession>>,
    Query(query): Query<AuthQuery>,
    Query(request): Query<SearchRequest>,
    headers: HeaderMap,
) -> Response {
    if !session.authorized(&headers, query.token.as_deref()) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let search = match session.corpus.prepare(&request) {
        Ok(search) => search,
        Err(err) => return error(StatusCode::BAD_REQUEST, &format!("{err:#}")),
    };
    let (sender, receiver) = mpsc::channel(SEARCH_EVENT_BUFFER);
    let corpus = session.corpus.clone();
    tokio::task::spawn_blocking(move || {
        corpus.run(&search, &|event| sender.blocking_send(event).is_ok());
    });
    let lines = stream::unfold(receiver, |mut receiver| async move {
        let event = receiver.recv().await?;
        let mut line = serde_json::to_vec(&event).unwrap_or_default();
        line.push(b'\n');
        Some((Ok::<_, Infallible>(line), receiver))
    });
    let mut response = Response::new(Body::from_stream(lines));
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson"),
    );
    response
}

async fn handle_file(
    State(session): State<Arc<ReviewSession>>,
    Query(query): Query<AuthQuery>,
    Query(request): Query<FileQuery>,
    headers: HeaderMap,
) -> Response {
    if !session.authorized(&headers, query.token.as_deref()) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let corpus = session.corpus.clone();
    match tokio::task::spawn_blocking(move || corpus.file(&request.path)).await {
        Ok(Ok(response)) => Json(response).into_response(),
        Ok(Err(err)) => error(StatusCode::NOT_FOUND, &format!("{err:#}")),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

async fn handle_comments(
    State(session): State<Arc<ReviewSession>>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
    Json(request): Json<CommentsRequest>,
) -> Response {
    if !session.authorized(&headers, query.token.as_deref()) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    session.replace_comments(request.comments);
    Json(OkResponse { ok: true }).into_response()
}

async fn handle_complete(
    State(session): State<Arc<ReviewSession>>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !session.authorized(&headers, query.token.as_deref()) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if !body.trim().is_empty() {
        match serde_json::from_str::<CommentsRequest>(&body) {
            Ok(request) => session.replace_comments(request.comments),
            Err(err) => return error(StatusCode::BAD_REQUEST, &err.to_string()),
        }
    }
    if !session.completed.swap(true, Ordering::SeqCst) {
        session.done.notify_waiters();
    }
    Json(OkResponse { ok: true }).into_response()
}

async fn static_asset(request: Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let Some(asset) = frontend::asset(request.uri().path()) else {
        return error(StatusCode::NOT_FOUND, "not found");
    };
    let mut response = if request.method() == Method::HEAD {
        Response::new(Body::empty())
    } else {
        Response::new(Body::from(asset.bytes))
    };
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&asset.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response
}

impl ReviewSession {
    fn authorized(&self, headers: &HeaderMap, token: Option<&str>) -> bool {
        let header_token = headers
            .get("X-Review-Token")
            .and_then(|value| value.to_str().ok());
        header_token
            .or(token)
            .is_some_and(|value| value == self.token)
    }

    fn comments_snapshot(&self) -> Vec<ReviewComment> {
        self.comments
            .lock()
            .expect("comments mutex poisoned")
            .clone()
    }

    fn replace_comments(&self, comments: Vec<ReviewComment>) {
        *self.comments.lock().expect("comments mutex poisoned") = normalize_comments(comments);
    }
}

fn new_token() -> Result<String> {
    let mut raw = [0u8; TOKEN_BYTES];
    fill(&mut raw).map_err(|err| anyhow::anyhow!("fill random token: {err:?}"))?;
    Ok(hex::encode(raw))
}

fn open_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .context("spawn open")?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .context("spawn browser")?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .context("spawn xdg-open")?;
    }
    Ok(())
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
        .into_response()
}
