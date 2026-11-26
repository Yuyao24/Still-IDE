use crate::{
    process::{check, command, Jobs},
    workspace::{err, relative, resolve, root, Result},
};
use serde::Serialize;
use std::{path::Path, process::Command};
use tauri::{AppHandle, State};

fn git(cwd: &Path) -> Command {
    let mut command = command("git", cwd);
    command
        .arg("--literal-pathspecs")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}

fn text(cmd: &mut Command) -> Result<String> {
    Ok(String::from_utf8_lossy(&check(cmd.output().map_err(err)?)?.stdout).into_owned())
}

pub fn initialize_sample(cwd: &Path) {
    if cwd.join(".git").exists() {
        return;
    }
    let sample_git = || {
        let mut cmd = git(cwd);
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        cmd.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", null)
            .args([
                "-c",
                "init.templateDir=",
                "-c",
                "core.hooksPath=.git/still-hooks",
            ]);
        cmd
    };
    let succeeded = |cmd: &mut Command| cmd.output().is_ok_and(|output| output.status.success());
    if succeeded(sample_git().args(["init", "--initial-branch=main"]))
        && succeeded(sample_git().args([
            "add",
            "--",
            "src",
            "README.md",
            "requirements.txt",
            ".gitignore",
        ]))
    {
        let _ = sample_git()
            .args([
                "-c",
                "user.name=Still",
                "-c",
                "user.email=sample@still.invalid",
                "commit",
                "--no-gpg-sign",
                "-m",
                "Add orbital period examples",
            ])
            .output();
    }
}

#[derive(Serialize)]
pub struct Change {
    path: String,
    index: char,
    worktree: char,
    original: Option<String>,
}

#[derive(Serialize)]
pub struct GitStatus {
    branch: Option<String>,
    changes: Vec<Change>,
}

#[tauri::command]
pub async fn git_status(root_path: String) -> Result<GitStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let output = git(&cwd)
            .args(["rev-parse", "--show-prefix"])
            .output()
            .map_err(err)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("not a git repository") {
                return Ok(GitStatus {
                    branch: None,
                    changes: Vec::new(),
                });
            }
            return Err(stderr.trim().to_owned());
        }
        let prefix = String::from_utf8_lossy(&output.stdout);
        let prefix = prefix.trim_end_matches(['\r', '\n']);
        let branch = text(git(&cwd).args(["symbolic-ref", "--short", "HEAD"]))
            .or_else(|_| text(git(&cwd).args(["rev-parse", "--short", "HEAD"])))?
            .trim()
            .to_owned();
        let entries =
            text(git(&cwd).args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]))?;
        let mut fields = entries.split_terminator('\0');
        let mut changes = Vec::new();
        while let Some(entry) = fields.next() {
            let mut flags = entry.chars();
            let (Some(index), Some(worktree), Some(' ')) =
                (flags.next(), flags.next(), flags.next())
            else {
                continue;
            };
            let original = if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
                fields
                    .next()
                    .and_then(|path| path.strip_prefix(prefix))
                    .map(String::from)
            } else {
                None
            };
            if let Some(path) = flags.as_str().strip_prefix(prefix) {
                changes.push(Change {
                    path: path.to_owned(),
                    index,
                    worktree,
                    original,
                });
            }
        }
        Ok(GitStatus {
            branch: Some(branch),
            changes,
        })
    })
    .await
    .map_err(err)?
}

fn repo_prefix(cwd: &Path) -> Result<String> {
    text(git(cwd).args(["rev-parse", "--show-prefix"]))
        .map(|prefix| prefix.trim_end_matches(['\r', '\n']).to_owned())
}

fn blob(cwd: &Path, spec: &str) -> Result<String> {
    let output = git(cwd).args(["show", spec]).output().map_err(err)?;
    if !output.status.success() {
        return Ok(String::new());
    }
    if output.stdout.len() > 4 * 1024 * 1024 || output.stdout.contains(&0) {
        return Err("Diff opens text files up to 4 MB.".into());
    }
    let text = String::from_utf8(output.stdout).map_err(err)?;
    Ok(text)
}

#[derive(Serialize)]
pub struct Diff {
    before: String,
    after: String,
}

#[tauri::command]
pub async fn git_diff(
    root_path: String,
    path: String,
    original: Option<String>,
    staged: bool,
) -> Result<Diff> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        let prefix = repo_prefix(&cwd)?;
        let indexed = format!(":{prefix}{path}");
        if staged {
            let old_path = original.as_deref().unwrap_or(&path);
            relative(old_path)?;
            return Ok(Diff {
                before: blob(&cwd, &format!("HEAD:{prefix}{old_path}"))?,
                after: blob(&cwd, &indexed)?,
            });
        }
        let before = blob(&cwd, &indexed)?;
        let after = match cwd.join(&path).symlink_metadata() {
            Ok(_) => crate::workspace::read_file(root_path, path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(err(error)),
        };
        Ok(Diff { before, after })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn git_stage(
    root_path: String,
    path: String,
    original: Option<String>,
    unstaged: bool,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        if let Some(original) = original.as_deref() {
            relative(original)?;
        }
        if cwd.join(&path).exists() {
            resolve(&cwd, &path)?;
        }
        let mut cmd = git(&cwd);
        if unstaged {
            let has_head = git(&cwd)
                .args(["rev-parse", "--verify", "HEAD"])
                .output()
                .map_err(err)?
                .status
                .success();
            if has_head {
                cmd.args(["reset", "-q", "HEAD", "--", &path]);
            } else {
                cmd.args(["rm", "--cached", "-f", "--", &path]);
            }
        } else {
            cmd.args(["add", "-A", "--", &path]);
        }
        if let Some(original) = original {
            cmd.arg(original);
        }
        check(cmd.output().map_err(err)?)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn git_action(
    app: AppHandle,
    jobs: State<Jobs>,
    root_path: String,
    id: String,
    action: String,
    message: Option<String>,
) -> Result<()> {
    let cwd = root(&root_path)?;
    jobs.start(app, id, false, move |job| {
        let mut cmd = git(&cwd);
        let mut label = action.clone();
        match action.as_str() {
            "commit" => {
                let message = message
                    .as_deref()
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
                    .ok_or("Enter a commit message.")?;
                cmd.args(["commit", "-m", message]);
            }
            "push" => {
                let upstream = git(&cwd).args(["rev-parse", "--abbrev-ref", "@{u}"]).output().is_ok_and(|out| out.status.success());
                if upstream {
                    cmd.args(["push", "--progress"]);
                } else {
                    let remote = text(git(&cwd).args(["remote"]))?;
                    let remote = remote.lines().find(|name| *name == "origin").or_else(|| remote.lines().next())
                        .ok_or("This repository has no remote. Add one with `git remote add origin <url>` in the terminal.")?
                        .to_owned();
                    label = format!("push -u {remote} HEAD");
                    cmd.args(["push", "--progress", "-u", &remote, "HEAD"]);
                }
            }
            "pull" => {
                cmd.args(["pull", "--ff-only", "--progress"]);
            }
            "fetch" => {
                cmd.args(["fetch", "--all", "--prune", "--progress"]);
            }
            _ => return Err("Unknown Git action.".into()),
        }
        job.emit("command", format!("$ git {label}\n"));
        let (code, _) = job.run(&mut cmd, false)?;
        Ok((code, Vec::new()))
    })
}

#[derive(Serialize)]
pub struct Branches {
    current: Option<String>,
    local: Vec<String>,
    remote: Vec<String>,
}

#[tauri::command]
pub async fn git_branches(root_path: String) -> Result<Branches> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let list = |kind: &str| -> Result<Vec<String>> {
            Ok(text(git(&cwd).args(["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", kind]))?
                .lines()
                .filter(|name| !name.ends_with("/HEAD") && !name.is_empty())
                .map(String::from)
                .collect())
        };
        Ok(Branches {
            current: text(git(&cwd).args(["symbolic-ref", "--short", "HEAD"])).ok().map(|name| name.trim().to_owned()),
            local: list("refs/heads")?,
            remote: list("refs/remotes")?,
        })
    })
    .await
    .map_err(err)?
}

fn valid_branch(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('-')
        || name.contains("..")
        || name.ends_with('/')
        || name.ends_with(".lock")
        || name.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
    {
        return Err("Enter a valid branch name.".into());
    }
    Ok(name)
}

#[tauri::command]
pub async fn git_checkout(root_path: String, branch: String, create: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let branch = valid_branch(&branch)?.to_owned();
        let mut cmd = git(&cwd);
        if create {
            cmd.args(["checkout", "-b", &branch]);
        } else if let Some((_, local)) = branch.split_once('/').filter(|_| {
            git(&cwd).args(["show-ref", "--verify", "--quiet", &format!("refs/remotes/{branch}")]).status().is_ok_and(|status| status.success())
        }) {
            // A remote branch: create or switch to the tracking branch.
            let exists = git(&cwd).args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{local}")]).status().is_ok_and(|status| status.success());
            if exists {
                cmd.args(["checkout", local]);
            } else {
                cmd.args(["checkout", "--track", &branch]);
            }
        } else {
            cmd.args(["checkout", &branch]);
        }
        check(cmd.output().map_err(err)?)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn git_stage_all(root_path: String, unstage: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let mut cmd = git(&cwd);
        if unstage {
            let has_head = git(&cwd).args(["rev-parse", "--verify", "HEAD"]).output().map_err(err)?.status.success();
            if has_head {
                cmd.args(["reset", "-q", "HEAD", "--", "."]);
            } else {
                cmd.args(["rm", "--cached", "-r", "-q", "-f", "--", "."]);
            }
        } else {
            cmd.args(["add", "-A", "--", "."]);
        }
        check(cmd.output().map_err(err)?)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn git_discard(root_path: String, path: String, untracked: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        relative(&path)?;
        if untracked {
            // Untracked files go to the system trash so they can be recovered.
            let full = resolve(&cwd, &path)?;
            return trash::delete(full).map_err(err);
        }
        check(git(&cwd).args(["checkout", "--", &path]).output().map_err(err)?)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
pub struct Commit {
    hash: String,
    subject: String,
    author: String,
    when: String,
}

#[tauri::command]
pub async fn git_log(root_path: String) -> Result<Vec<Commit>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let output = git(&cwd).args(["log", "-n", "40", "--pretty=format:%h%x1f%s%x1f%an%x1f%ar"]).output().map_err(err)?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\x1f');
                Some(Commit {
                    hash: parts.next()?.into(),
                    subject: parts.next()?.into(),
                    author: parts.next()?.into(),
                    when: parts.next()?.into(),
                })
            })
            .collect())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn git_init(root_path: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let ok = git(&cwd).args(["init", "-q", "-b", "main"]).output().is_ok_and(|out| out.status.success());
        if !ok {
            check(git(&cwd).args(["init", "-q"]).output().map_err(err)?)?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
pub struct Stash {
    index: u32,
    message: String,
    when: String,
}

/// Stashes: put changes aside (`push`, untracked files too), bring the latest back (`pop`),
/// or apply / drop a particular one. Returns the list after the action.
#[tauri::command]
pub async fn git_stash(root_path: String, action: String, index: Option<u32>, message: Option<String>) -> Result<Vec<Stash>> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let target = format!("stash@{{{}}}", index.unwrap_or(0));
        match action.as_str() {
            "push" => {
                let mut cmd = git(&cwd);
                cmd.args(["stash", "push", "--include-untracked"]);
                if let Some(message) = message.as_deref().map(str::trim).filter(|value| !value.is_empty()) { cmd.args(["-m", message]); }
                check(cmd.output().map_err(err)?)?;
            }
            "pop" => { check(git(&cwd).args(["stash", "pop", &target]).output().map_err(err)?)?; }
            "apply" => { check(git(&cwd).args(["stash", "apply", &target]).output().map_err(err)?)?; }
            "drop" => { check(git(&cwd).args(["stash", "drop", &target]).output().map_err(err)?)?; }
            "list" => {}
            _ => return Err("Unknown stash action.".into()),
        }
        let listing = text(git(&cwd).args(["stash", "list", "--format=%gd%x1f%s%x1f%cr"]))?;
        Ok(listing.lines().filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let reference = parts.next()?;
            let index = reference.trim_start_matches("stash@{").trim_end_matches('}').parse().ok()?;
            Some(Stash { index, message: parts.next().unwrap_or("").to_owned(), when: parts.next().unwrap_or("").to_owned() })
        }).collect())
    })
    .await
    .map_err(err)?
}

/// Applies a patch for one change: to the index (stage it), or in reverse to the index (unstage it).
#[tauri::command]
pub async fn git_apply_patch(root_path: String, patch: String, cached: bool, reverse: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let cwd = root(&root_path)?;
        let mut cmd = git(&cwd);
        cmd.args(["apply", "--unidiff-zero", "--whitespace=nowarn", "--recount"]);
        if cached { cmd.arg("--cached"); }
        if reverse { cmd.arg("--reverse"); }
        cmd.arg("-").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(err)?;
        if let Some(mut stdin) = child.stdin.take() { stdin.write_all(patch.as_bytes()).map_err(err)?; }
        check(child.wait_with_output().map_err(err)?)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

/// The `origin` remote's URL (empty when there is none).
#[tauri::command]
pub async fn git_remote_url(root_path: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        Ok(git(&cwd).args(["remote", "get-url", "origin"]).output().ok().filter(|out| out.status.success()).map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned()).unwrap_or_default())
    })
    .await
    .map_err(err)?
}

/// Fetches a GitHub pull request into a local branch `pr-<number>` and switches to it.
#[tauri::command]
pub async fn git_checkout_pr(root_path: String, number: u32) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = root(&root_path)?;
        let branch = format!("pr-{number}");
        check(git(&cwd).args(["fetch", "origin", &format!("pull/{number}/head:{branch}"), "--force"]).output().map_err(err)?)?;
        check(git(&cwd).args(["checkout", &branch]).output().map_err(err)?)?;
        Ok(branch)
    })
    .await
    .map_err(err)?
}
