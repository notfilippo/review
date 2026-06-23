use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::parser::ValueSource;
use clap::{ArgAction, CommandFactory, FromArgMatches, Parser};

const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7527";

#[derive(Clone, Debug)]
pub struct CliOptions {
    pub listen_addr: SocketAddr,
    pub allow_port_fallback: bool,
    pub cwd: PathBuf,
    pub revisions: Vec<String>,
    pub from_rev: Option<String>,
    pub to_rev: Option<String>,
    pub paths: Vec<String>,
}

#[derive(Debug, Parser)]
#[command(
    author = env!("CARGO_PKG_AUTHORS"),
    version = env!("CARGO_PKG_VERSION"),
    about = env!("CARGO_PKG_DESCRIPTION"),
    long_about = None
)]
struct Args {
    #[arg(
        long = "addr",
        value_name = "ADDR",
        default_value = DEFAULT_LISTEN_ADDR,
        help = "Serve the review UI on this address"
    )]
    addr: SocketAddr,
    #[arg(long = "port", value_name = "PORT", help = "Serve on 127.0.0.1:<PORT>")]
    port: Option<u16>,
    #[arg(
        short = 'r',
        value_name = "REVSET",
        action = ArgAction::Append,
        conflicts_with_all = ["from_rev", "to_rev"],
        help = "Review a jj revset, or one Git commit",
    )]
    revisions: Vec<String>,
    #[arg(
        long = "from",
        value_name = "REV",
        help = "Old revision for a range review"
    )]
    from_rev: Option<String>,
    #[arg(
        long = "to",
        value_name = "REV",
        help = "New revision for a range review"
    )]
    to_rev: Option<String>,
    #[arg(value_name = "PATH", help = "Limit review to these paths")]
    paths: Vec<String>,
}

pub fn parse() -> Result<CliOptions> {
    let matches = Args::command().get_matches();
    let addr_source = matches.value_source("addr");
    let port_source = matches.value_source("port");
    let args = Args::from_arg_matches(&matches).unwrap_or_else(|err| err.exit());

    if addr_source == Some(ValueSource::CommandLine)
        && port_source == Some(ValueSource::CommandLine)
    {
        bail!("use --addr or --port, not both");
    }

    let listen_addr = args
        .port
        .map_or(args.addr, |port| SocketAddr::from(([127, 0, 0, 1], port)));

    Ok(CliOptions {
        listen_addr,
        allow_port_fallback: addr_source == Some(ValueSource::DefaultValue)
            && port_source.is_none(),
        cwd: env::current_dir().context("read current directory")?,
        revisions: trim_required_values(args.revisions, "revision")?,
        from_rev: trim_optional(args.from_rev),
        to_rev: trim_optional(args.to_rev),
        paths: trim_required_values(args.paths, "path")?,
    })
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn trim_required_values(values: Vec<String>, name: &str) -> Result<Vec<String>> {
    values
        .into_iter()
        .map(|value| {
            let value = value.trim().to_string();
            if value.is_empty() {
                bail!("{name} cannot be empty");
            }
            Ok(value)
        })
        .collect()
}
