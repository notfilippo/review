use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{ArgAction, Parser};

const DEFAULT_PORT: u16 = 7527;

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
#[command(author, version, about)]
struct Args {
    #[arg(long = "addr", value_name = "ADDR")]
    addr: Option<SocketAddr>,
    #[arg(long = "port", value_name = "PORT")]
    port: Option<u16>,
    #[arg(short = 'r', value_name = "REVSET", action = ArgAction::Append)]
    revisions: Vec<String>,
    #[arg(long = "from", value_name = "REV")]
    from_rev: Option<String>,
    #[arg(long = "to", value_name = "REV")]
    to_rev: Option<String>,
    #[arg(value_name = "PATH")]
    paths: Vec<String>,
}

pub fn parse() -> Result<CliOptions> {
    let args = Args::parse();
    if args.addr.is_some() && args.port.is_some() {
        bail!("use --addr or --port, not both");
    }
    if !args.revisions.is_empty() && (args.from_rev.is_some() || args.to_rev.is_some()) {
        bail!("use -r or --from/--to, not both");
    }

    let listen_addr = match (args.addr, args.port) {
        (Some(addr), None) => addr,
        (None, Some(port)) => SocketAddr::from(([127, 0, 0, 1], port)),
        (None, None) => SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)),
        (Some(_), Some(_)) => unreachable!("checked above"),
    };

    Ok(CliOptions {
        listen_addr,
        allow_port_fallback: args.addr.is_none() && args.port.is_none(),
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
