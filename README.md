# container-pi


```
        _
  _ __ (_)  container-pi
 | '_ \| |
 | |_) | |
 | .__/|_|
 |_|
```

Built with [Pi](https://pi.dev), but in no way associated with the builders of the very excellent [Pi Coding Agent](https://github.com/badlogic/pi-mono) itself.


Run `pi` inside a per-project Linux container, with the current folder mounted read-write and the live Pi UI running inside tmux.

## Prerequisite: set up Pi locally first

Before using `container-pi`, install and run the Pi Coding Agent locally at least once and log in to your subscription/provider there:

```bash
npm install -g @mariozechner/pi-coding-agent
pi
# inside pi: /login
```

`container-pi` mounts your local `~/.pi`, `~/.agents`, `~/.codex`, and `~/.claude` folders into the container, so it reuses your existing Pi auth, settings, skills, prompts, extensions, and sessions. If you have not logged in locally first, the container will not have your subscription/auth state.

## Why TypeScript/tsx?

A TypeScript wrapper is nicer than shell for Linux/macOS portability. It avoids `sed`/`readlink`/`sha1sum` differences, gives cleaner argument handling, and is easier to extend.

There is still a tiny Node entrypoint inside the container because the container must create a user matching your host UID/GID, start tmux, and keep the container alive.

## What gets mounted

For convenience/auth reuse, this mounts the whole agent config folders:

- `~/.pi` -> `/home/pi/.pi`
- `~/.agents` -> `/home/pi/.agents`
- `~/.codex` -> `/home/pi/.codex`
- `~/.claude` -> `/home/pi/.claude`
- current project -> `/workspace`

This means Pi skills, prompts, extensions, packages, sessions, settings, auth, and related Claude/Codex config are available without re-login.

Security note: those folders may contain credentials/tokens. This is convenient but only use images you trust.

## Install/use from this folder

```bash
cd container-pi
npm install
npm run container-pi -- status
```

Run in another repo/folder by invoking the script path:

```bash
cd /path/to/project
npx tsx /home/amanrai/Code/container-pi/src/container-pi.ts
```

## Make `container-pi` available as a command

Run these from inside the cloned `container-pi` repo. They capture the repo's current path with `pwd`, so there is no hardcoded install location.

### macOS/Linux, zsh

```bash
printf "alias container-pi='npx tsx %s/src/container-pi.ts'\n" "$(pwd)" >> ~/.zshrc
source ~/.zshrc
```

### Linux, bash

```bash
printf "alias container-pi='npx tsx %s/src/container-pi.ts'\n" "$(pwd)" >> ~/.bashrc
source ~/.bashrc
```

### Current shell only

```bash
alias container-pi="npx tsx $(pwd)/src/container-pi.ts"
```

Then from any project:

```bash
cd /path/to/project
container-pi
```

With no arguments, `container-pi` opens a small terminal UI. Choose **Sessions** to see existing sessions plus **New session** and **Start session in worktree**. New session opens a directory browser so you can choose the workspace. Worktree session prompts for a branch name/path, creates a Git worktree, and starts Pi there. Selecting an existing session opens a second menu with **Attach** and **Stop/remove**; sessions running from a linked Git worktree also show **Generate PR** and **Publish branch**.

Use **Configure worktree path** from the main menu to set where new worktrees are created. The default is `/tmp/container-pi/worktrees`.

## Commands

```bash
container-pi                  # open the TUI
container-pi tui              # open the TUI explicitly
container-pi run              # start default project container, run pi in tmux, attach
container-pi attach           # attach to existing tmux session
container-pi shell            # open shell in same container
container-pi stop             # remove default project container
container-pi status           # show image/container/project info
container-pi logs             # follow container logs
container-pi list             # list running container-pi containers
container-pi build            # build image
container-pi rebuild          # rebuild image with --no-cache
```

Pi args pass through via `run`:

```bash
container-pi run --model sonnet:high
container-pi run -p "summarize this repo"
container-pi run --offline
```

If you prefer the old no-TUI behavior:

```bash
CONTAINER_PI_NO_TUI=1 container-pi
```

Detach from tmux with `Ctrl-b d`.

Directory browser keys:

- `Enter` on a directory descends into it
- `Enter` on `✓ Use this directory` starts a new session there
- `Backspace` goes up one directory
- `~` jumps to your home directory
- `/` jumps to filesystem root
- `Esc` returns to the sessions list

## Hooks

`container-pi` runs optional bash hooks from both of these locations, in this order:

```text
<project>/.container-pi/hooks/<hook>
<project>/.container-pi/hooks/<hook>.sh
~/.config/container-pi/hooks/<hook>
~/.config/container-pi/hooks/<hook>.sh
```

Supported hooks:

```text
pre-load          before loading/starting a session; non-zero exit aborts startup
session-attach    immediately before attaching to tmux
session-detach    after returning from tmux attach/detach
shutdown          before removing a container-pi container
```

Hook environment:

```bash
CONTAINER_PI_HOOK       # hook name
CONTAINER_PI_CONTAINER  # Docker/Podman container name
CONTAINER_PI_PROJECT    # project/workspace path on the host
CONTAINER_PI_IMAGE      # image name
CONTAINER_PI_ENGINE     # docker or podman
```

Example:

```bash
mkdir -p .container-pi/hooks
cat > .container-pi/hooks/session-detach <<'EOF'
#!/usr/bin/env bash
echo "detached from $CONTAINER_PI_CONTAINER in $CONTAINER_PI_PROJECT"
EOF
chmod +x .container-pi/hooks/session-detach
```

## Environment

```bash
CONTAINER_PI_ENGINE=docker        # or podman
CONTAINER_PI_IMAGE=container-pi:latest
CONTAINER_PI_NAME=my-custom-name
CONTAINER_PI_NO_TUI=1              # make no-arg invocation run pi directly
CONTAINER_PI_WORKTREE_ROOT=/tmp/container-pi/worktrees
```

The wrapper also forwards common provider keys like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, AWS env vars, etc.
