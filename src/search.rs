use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use ignore::{WalkBuilder, WalkState};
use regex::bytes::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::diff::is_binary;
use crate::vcs::{FileStatus, ReviewInput};

const MAX_MATCHES: usize = 2000;
const PROGRESS_EVERY_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 400;
const LINE_LEAD_BYTES: usize = 80;
const SKIPPED_DIRS: [&str; 2] = [".git", ".jj"];

// Keywords that introduce a named item across common languages. Matching is
// line-based and heuristic; it ranks likely definitions, it does not resolve
// scopes.
const DEFINITION_KEYWORDS: &str = "fn|func|fun|def|class|struct|enum|trait|type|interface|union|mod|module|namespace|macro_rules!|function\\*?|let(?:\\s+mut)?|const|var|val|static|object|record|protocol|typealias|#define";

/// Repository snapshot used for reference search: the reviewed contents for
/// files in the diff, and the working copy on disk for everything else.
pub struct SearchCorpus {
    root: PathBuf,
    overlay: HashMap<String, Arc<[u8]>>,
    shadowed: HashSet<String>,
    scopes: Vec<Vec<String>>,
    generation: AtomicU64,
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub q: String,
    #[serde(default)]
    pub word: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
}

/// One NDJSON line of a streamed search.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SearchEvent {
    Scope {
        dirs: Vec<String>,
        searched_files: usize,
    },
    Progress {
        searched_files: usize,
    },
    File(SearchFile),
    Done(SearchSummary),
}

#[derive(Debug, Serialize)]
pub struct SearchSummary {
    pub match_count: usize,
    pub searched_files: usize,
    pub truncated: bool,
    pub cancelled: bool,
    pub elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct SearchFile {
    pub path: String,
    pub in_diff: bool,
    /// 0 for diff files, then one more per directory level away from the diff.
    pub distance: usize,
    pub matches: Vec<SearchMatch>,
}

pub struct PreparedSearch {
    matchers: Matchers,
    generation: u64,
}

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub line: usize,
    pub text: String,
    /// UTF-16 offsets into `text`.
    pub ranges: Vec<[usize; 2]>,
    pub clipped_start: bool,
    pub clipped_end: bool,
    pub definition: bool,
}

#[derive(Debug, Serialize)]
pub struct FileResponse {
    pub path: String,
    pub contents: String,
}

struct Matchers {
    query: Regex,
    definition: Option<Regex>,
}

struct LineHits {
    number: usize,
    start: usize,
    end: usize,
    ranges: Vec<(usize, usize)>,
}

struct SearchRun<'a> {
    emit: &'a (dyn Fn(SearchEvent) -> bool + Sync),
    generation: u64,
    matches: AtomicUsize,
    searched_files: AtomicUsize,
    truncated: AtomicBool,
    disconnected: AtomicBool,
}

impl SearchCorpus {
    pub fn new(root: PathBuf, input: &ReviewInput) -> Self {
        let mut overlay = HashMap::new();
        let mut shadowed = HashSet::new();
        for file in &input.files {
            shadowed.insert(file.old_file.name.clone());
            shadowed.insert(file.new_file.name.clone());
            if file.status != FileStatus::Deleted {
                overlay.insert(
                    file.new_file.name.clone(),
                    Arc::from(file.new_file.contents.as_bytes()),
                );
            }
        }
        let scopes = proximity_scopes(shadowed.iter().map(String::as_str));
        Self {
            root,
            overlay,
            shadowed,
            scopes,
            generation: AtomicU64::new(0),
        }
    }

    /// Validates a request and claims a new generation, which cancels any
    /// in-flight search so slow walks cannot pile up behind fresh queries.
    pub fn prepare(&self, request: &SearchRequest) -> Result<PreparedSearch> {
        let matchers = Matchers::new(request)?;
        Ok(PreparedSearch {
            matchers,
            generation: self.generation.fetch_add(1, Ordering::SeqCst) + 1,
        })
    }

    /// Streams matches nearest the diff first: diff files, their directories,
    /// then each ancestor level up to the repository root. Large repositories
    /// can take minutes to walk, so useful results must not wait for the end.
    /// `emit` returns false once nobody is listening.
    pub fn run(&self, search: &PreparedSearch, emit: &(dyn Fn(SearchEvent) -> bool + Sync)) {
        let started = Instant::now();
        let run = SearchRun {
            emit,
            generation: search.generation,
            matches: AtomicUsize::new(0),
            searched_files: AtomicUsize::new(0),
            truncated: AtomicBool::new(false),
            disconnected: AtomicBool::new(false),
        };

        let mut overlay_paths = self.overlay.keys().collect::<Vec<_>>();
        overlay_paths.sort();
        for path in overlay_paths {
            let matches = search_buffer(&self.overlay[path], &search.matchers);
            run.record(path, true, 0, matches);
        }

        let mut searched_dirs = HashSet::new();
        for (index, dirs) in self.scopes.iter().enumerate() {
            if self.should_stop(&run) {
                break;
            }
            run.send(SearchEvent::Scope {
                dirs: dirs.clone(),
                searched_files: run.searched_files.load(Ordering::Relaxed),
            });
            self.walk_scope(dirs, &searched_dirs, index + 1, &search.matchers, &run);
            searched_dirs.extend(dirs.iter().cloned());
        }

        run.send(SearchEvent::Done(SearchSummary {
            match_count: run.matches.load(Ordering::Relaxed).min(MAX_MATCHES),
            searched_files: run.searched_files.load(Ordering::Relaxed),
            truncated: run.truncated.load(Ordering::Relaxed),
            cancelled: self.generation.load(Ordering::SeqCst) != run.generation
                || run.disconnected.load(Ordering::Relaxed),
            elapsed_ms: started.elapsed().as_millis(),
        }));
    }

    fn walk_scope(
        &self,
        dirs: &[String],
        searched_dirs: &HashSet<String>,
        distance: usize,
        matchers: &Matchers,
        run: &SearchRun,
    ) {
        let mut roots = dirs.iter().map(|dir| self.root.join(dir));
        let Some(first) = roots.next() else {
            return;
        };
        let mut builder = WalkBuilder::new(first);
        for root in roots {
            builder.add(root);
        }
        let root = self.root.clone();
        let searched_dirs = searched_dirs.clone();
        let walker = builder
            .hidden(false)
            .require_git(false)
            .max_filesize(Some(MAX_FILE_BYTES))
            .filter_entry(move |entry| {
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| SKIPPED_DIRS.contains(&name))
                {
                    return false;
                }
                // Inner scopes were walked by an earlier, closer pass.
                !entry.file_type().is_some_and(|kind| kind.is_dir())
                    || relative_path(&root, entry.path())
                        .is_none_or(|path| !searched_dirs.contains(&path))
            })
            .build_parallel();
        walker.run(|| {
            Box::new(|entry| {
                if self.should_stop(run) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return WalkState::Continue;
                }
                let Some(path) = relative_path(&self.root, entry.path()) else {
                    return WalkState::Continue;
                };
                if self.shadowed.contains(&path) {
                    return WalkState::Continue;
                }
                let Ok(bytes) = fs::read(entry.path()) else {
                    return WalkState::Continue;
                };
                run.record(&path, false, distance, search_buffer(&bytes, matchers));
                WalkState::Continue
            })
        });
    }

    fn should_stop(&self, run: &SearchRun) -> bool {
        self.generation.load(Ordering::SeqCst) != run.generation
            || run.truncated.load(Ordering::Relaxed)
            || run.disconnected.load(Ordering::Relaxed)
    }

    pub fn file(&self, path: &str) -> Result<FileResponse> {
        let path = normalize_request_path(path)?;
        if let Some(contents) = self.overlay.get(&path) {
            return Ok(FileResponse {
                contents: String::from_utf8_lossy(contents).into_owned(),
                path,
            });
        }
        if self.shadowed.contains(&path) {
            bail!("{path} is deleted in this review");
        }
        let full_path = self
            .root
            .join(&path)
            .canonicalize()
            .with_context(|| format!("read {path}"))?;
        let root = self
            .root
            .canonicalize()
            .context("canonicalize repository")?;
        if !full_path.starts_with(&root) {
            bail!("path {path:?} must stay inside the repository");
        }
        let metadata = fs::metadata(&full_path).with_context(|| format!("read {path}"))?;
        if !metadata.is_file() {
            bail!("{path} is not a file");
        }
        if metadata.len() > MAX_FILE_BYTES {
            bail!("{path} is too large to display");
        }
        let bytes = fs::read(&full_path).with_context(|| format!("read {path}"))?;
        if is_binary(&bytes) {
            bail!("{path} is a binary file");
        }
        Ok(FileResponse {
            contents: String::from_utf8_lossy(&bytes).into_owned(),
            path,
        })
    }
}

impl SearchRun<'_> {
    fn record(&self, path: &str, in_diff: bool, distance: usize, mut matches: Vec<SearchMatch>) {
        let searched = self.searched_files.fetch_add(1, Ordering::Relaxed) + 1;
        if searched.is_multiple_of(PROGRESS_EVERY_FILES) {
            self.send(SearchEvent::Progress {
                searched_files: searched,
            });
        }
        if matches.is_empty() {
            return;
        }
        let previous = self.matches.fetch_add(matches.len(), Ordering::Relaxed);
        if previous >= MAX_MATCHES {
            self.truncated.store(true, Ordering::Relaxed);
            return;
        }
        if previous + matches.len() >= MAX_MATCHES {
            matches.truncate(MAX_MATCHES - previous);
            self.truncated.store(true, Ordering::Relaxed);
        }
        self.send(SearchEvent::File(SearchFile {
            path: path.to_string(),
            in_diff,
            distance,
            matches,
        }));
    }

    fn send(&self, event: SearchEvent) {
        if !(self.emit)(event) {
            self.disconnected.store(true, Ordering::Relaxed);
        }
    }
}

/// Directory sets to walk, closest to the diff first. Each pass replaces a
/// directory with its parent; the root waits for the last pass so a change to
/// a top-level file does not turn the first pass into a full repository walk.
fn proximity_scopes<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<Vec<String>> {
    let mut frontier = paths.map(parent_dir).collect::<BTreeSet<_>>();
    if frontier.len() > 1 {
        frontier.remove("");
    }
    let mut frontier = outermost_dirs(frontier);
    let mut scopes = Vec::new();
    while !frontier.is_empty() && frontier != [""] {
        let mut next = frontier
            .iter()
            .map(|dir| parent_dir(dir))
            .collect::<BTreeSet<_>>();
        next.remove("");
        scopes.push(frontier);
        frontier = outermost_dirs(next);
    }
    scopes.push(vec![String::new()]);
    scopes
}

fn parent_dir(path: &str) -> String {
    path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string()
}

/// Drops directories nested in another one of the set; walking the outer one
/// already covers them.
fn outermost_dirs(dirs: BTreeSet<String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for dir in dirs {
        let nested = kept.last().is_some_and(|outer| {
            outer.is_empty()
                || dir
                    .strip_prefix(outer.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        });
        if !nested {
            kept.push(dir);
        }
    }
    kept
}

impl Matchers {
    fn new(request: &SearchRequest) -> Result<Self> {
        let query = request.q.trim_end_matches(['\r', '\n']);
        if query.trim().is_empty() {
            bail!("search query is empty");
        }
        let body = if request.regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let pattern = if request.word {
            word_pattern(query, &body, request.regex)
        } else {
            body
        };
        let case_sensitive = request
            .case_sensitive
            .unwrap_or_else(|| query.chars().any(char::is_uppercase));
        let query_regex = RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .multi_line(true)
            .build()
            .context("invalid search pattern")?;
        let definition = (!request.regex && is_identifier(query))
            .then(|| definition_regex(query))
            .transpose()?;
        Ok(Self {
            query: query_regex,
            definition,
        })
    }
}

fn word_pattern(query: &str, body: &str, regex: bool) -> String {
    let is_word = |character: Option<char>| character.is_some_and(is_word_char);
    let start = if regex || is_word(query.chars().next()) {
        r"\b"
    } else {
        ""
    };
    let end = if regex || is_word(query.chars().last()) {
        r"\b"
    } else {
        ""
    };
    format!("{start}(?:{body}){end}")
}

fn definition_regex(name: &str) -> Result<Regex> {
    let name = regex::escape(name);
    // Optional `(receiver)` covers Go methods; optional `<...>` covers generics.
    let pattern =
        format!(r"(?:^|[^\w])(?:{DEFINITION_KEYWORDS})\s+(?:\([^)]*\)\s*)?(?:<[^>]*>\s*)?{name}\b");
    Regex::new(&pattern).context("build definition pattern")
}

fn is_identifier(text: &str) -> bool {
    !text.is_empty() && text.chars().all(is_word_char)
}

fn is_word_char(character: char) -> bool {
    character == '_' || character.is_alphanumeric()
}

fn search_buffer(bytes: &[u8], matchers: &Matchers) -> Vec<SearchMatch> {
    if is_binary(bytes) {
        return Vec::new();
    }
    let mut results = Vec::new();
    let mut line_number = 1;
    let mut line_start = 0;
    let mut scanned = 0;
    let mut current: Option<LineHits> = None;

    for found in matchers.query.find_iter(bytes) {
        if found.start() == found.end() {
            continue;
        }
        let gap = &bytes[scanned..found.start()];
        if let Some(last_newline) = gap.iter().rposition(|byte| *byte == b'\n') {
            line_number += gap.iter().filter(|byte| **byte == b'\n').count();
            line_start = scanned + last_newline + 1;
        }
        scanned = found.start();

        if current
            .as_ref()
            .is_some_and(|line| line.number != line_number)
        {
            results.extend(finish_line(bytes, current.take(), matchers));
        }
        let line_end = bytes[found.start()..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |offset| found.start() + offset);
        let range = (
            found.start() - line_start,
            found.end().min(line_end) - line_start,
        );
        match &mut current {
            Some(line) => line.ranges.push(range),
            None => {
                current = Some(LineHits {
                    number: line_number,
                    start: line_start,
                    end: line_end,
                    ranges: vec![range],
                });
            }
        }
    }
    results.extend(finish_line(bytes, current, matchers));
    results
}

fn finish_line(bytes: &[u8], line: Option<LineHits>, matchers: &Matchers) -> Option<SearchMatch> {
    let LineHits {
        number,
        start,
        end,
        ranges,
    } = line?;
    let raw = &bytes[start..end];
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    let definition = matchers
        .definition
        .as_ref()
        .is_some_and(|definition| definition.is_match(raw));
    let Ok(text) = std::str::from_utf8(raw) else {
        return Some(SearchMatch {
            line: number,
            text: String::from_utf8_lossy(raw).into_owned(),
            ranges: Vec::new(),
            clipped_start: false,
            clipped_end: false,
            definition,
        });
    };
    let first = ranges.first().map_or(0, |range| range.0.min(text.len()));
    let clip_start = if text.len() > MAX_LINE_BYTES {
        text.floor_char_boundary(first.saturating_sub(LINE_LEAD_BYTES))
    } else {
        0
    };
    let clip_end = text.ceil_char_boundary((clip_start + MAX_LINE_BYTES).min(text.len()));
    let utf16 = |offset: usize| text[clip_start..offset].encode_utf16().count();
    let ranges = ranges
        .iter()
        .filter(|range| range.0 < clip_end && range.1 > clip_start)
        .map(|range| {
            let from = text.floor_char_boundary(range.0.max(clip_start));
            let to = text.ceil_char_boundary(range.1.min(clip_end));
            [utf16(from), utf16(to)]
        })
        .collect();
    Some(SearchMatch {
        line: number,
        text: text[clip_start..clip_end].to_string(),
        ranges,
        clipped_start: clip_start > 0,
        clipped_end: clip_end < text.len(),
        definition,
    })
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        parts.push(component.as_os_str().to_str()?);
    }
    Some(parts.join("/"))
}

fn normalize_request_path(path: &str) -> Result<String> {
    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_str().context("path is not valid UTF-8")?;
                if SKIPPED_DIRS.contains(&part) {
                    bail!("path {path:?} is not searchable");
                }
                parts.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("path {path:?} must stay inside the repository");
            }
        }
    }
    if parts.is_empty() {
        bail!("path is empty");
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        Matchers, SearchCorpus, SearchEvent, SearchRequest, normalize_request_path,
        proximity_scopes, search_buffer,
    };
    use crate::vcs::{FileContents, FileStatus, ReviewFile, ReviewInput};

    fn request(q: &str, word: bool) -> SearchRequest {
        SearchRequest {
            q: q.to_string(),
            word,
            regex: false,
            case_sensitive: Some(true),
        }
    }

    #[test]
    fn word_search_groups_matches_by_line_and_flags_definitions() {
        let source = b"use crate::render_patch;\n\npub fn render_patch(files: &[File]) {}\nfn other() { render_patch(&[]); render_patch(&[]); }\nrender_patches();\n";
        let matchers = Matchers::new(&request("render_patch", true)).expect("build matchers");

        let matches = search_buffer(source, &matchers);

        let summary = matches
            .iter()
            .map(|item| (item.line, item.ranges.len(), item.definition))
            .collect::<Vec<_>>();
        assert_eq!(summary, [(1, 1, false), (3, 1, true), (4, 2, false)]);
        assert_eq!(matches[1].ranges, [[7, 19]]);
    }

    #[test]
    fn go_methods_and_js_functions_are_definitions() {
        let matchers = Matchers::new(&request("Serve", true)).expect("build matchers");
        let matches = search_buffer(
            b"func (s *Server) Serve(ctx context.Context) error {\nexport async function Serve() {}\ns.Serve(ctx)\n",
            &matchers,
        );
        let definitions = matches
            .iter()
            .map(|item| item.definition)
            .collect::<Vec<_>>();
        assert_eq!(definitions, [true, true, false]);
    }

    #[test]
    fn ranges_use_utf16_offsets() {
        let matchers = Matchers::new(&request("name", false)).expect("build matchers");
        let matches = search_buffer("let 🦀 = name;\n".as_bytes(), &matchers);
        assert_eq!(matches[0].ranges, [[9, 13]]);
    }

    #[test]
    fn long_lines_are_clipped_around_the_match() {
        let line = format!("{}needle{}\n", "a".repeat(1000), "b".repeat(1000));
        let matchers = Matchers::new(&request("needle", false)).expect("build matchers");
        let matches = search_buffer(line.as_bytes(), &matchers);
        let item = &matches[0];
        assert!(item.clipped_start && item.clipped_end);
        assert_eq!(&item.text[item.ranges[0][0]..item.ranges[0][1]], "needle");
    }

    #[test]
    fn binary_files_are_skipped() {
        let matchers = Matchers::new(&request("needle", false)).expect("build matchers");
        assert!(search_buffer(b"needle\0", &matchers).is_empty());
    }

    #[test]
    fn request_paths_cannot_escape_the_repository() {
        assert_eq!(
            normalize_request_path("./src/main.rs").expect("relative path"),
            "src/main.rs"
        );
        for path in ["../secret", "/etc/passwd", "src/../../x", ".git/config", ""] {
            assert!(normalize_request_path(path).is_err(), "{path} should fail");
        }
    }

    #[test]
    fn scopes_widen_from_the_diff_to_the_root() {
        let scopes = proximity_scopes(
            [
                "svc/api/handler.go",
                "svc/api/v2/routes.go",
                "lib/x.go",
                "go.mod",
            ]
            .into_iter(),
        );
        assert_eq!(
            scopes,
            [
                vec!["lib".to_string(), "svc/api".to_string()],
                vec!["svc".to_string()],
                vec![String::new()],
            ]
        );
        assert_eq!(
            proximity_scopes(["README.md"].into_iter()),
            [vec![String::new()]]
        );
        assert_eq!(proximity_scopes(std::iter::empty()), [vec![String::new()]]);
    }

    #[test]
    fn run_streams_diff_files_then_nearest_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time follows the Unix epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("review-search-{}-{unique}", std::process::id()));
        for (path, contents) in [
            ("a/b/new.rs", "stale on disk: helper\n"),
            ("a/b/sibling.rs", "helper();\n"),
            ("a/cousin.rs", "helper();\n"),
            ("far/away.rs", "helper();\n"),
            ("ignored/skip.rs", "helper();\n"),
            (".gitignore", "ignored/\n"),
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().expect("test path has a parent"))
                .expect("create test dir");
            fs::write(path, contents).expect("write test file");
        }
        let input = ReviewInput {
            files: vec![ReviewFile {
                path: "a/b/new.rs".to_string(),
                status: FileStatus::Added,
                patch: String::new(),
                old_file: FileContents {
                    name: "a/b/new.rs".to_string(),
                    contents: String::new(),
                },
                new_file: FileContents {
                    name: "a/b/new.rs".to_string(),
                    contents: "pub fn helper() {}\n".to_string(),
                },
            }],
        };
        let corpus = SearchCorpus::new(root.clone(), &input);
        let search = corpus
            .prepare(&request("helper", true))
            .expect("prepare search");
        let events = Mutex::new(Vec::new());
        corpus.run(&search, &|event| {
            events.lock().expect("events mutex").push(event);
            true
        });

        let summary = events
            .into_inner()
            .expect("events mutex")
            .into_iter()
            .map(|event| match event {
                SearchEvent::Scope { dirs, .. } => format!("scope {}", dirs.join(",")),
                SearchEvent::File(file) => format!(
                    "{} d{} def={}",
                    file.path, file.distance, file.matches[0].definition
                ),
                SearchEvent::Progress { .. } => "progress".to_string(),
                SearchEvent::Done(done) => format!("done {} {}", done.match_count, done.cancelled),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                "a/b/new.rs d0 def=true",
                "scope a/b",
                "a/b/sibling.rs d1 def=false",
                "scope a",
                "a/cousin.rs d2 def=false",
                "scope ",
                "far/away.rs d3 def=false",
                "done 4 false",
            ]
        );
        fs::remove_dir_all(root).expect("remove test dir");
    }
}
