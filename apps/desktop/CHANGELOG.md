# @dbchat/desktop

## 0.1.3

### Patch Changes

- bb7252d: Fix editing saved database connections, including URL-backed connections, credential reuse during connection tests, and switching between URL and field-based configuration.

## 0.1.2

### Patch Changes

- 7db310f: Add a visible in-app update checker to the workspace sidebar and enlarge the sidebar footer controls.
- c1a6b86: Desktop app now stores its sqlite database and key in `~/.dbchat` (or `DBCHAT_HOME`), the same location as the dev server, so chat history survives reinstalls and is shared between dev and packaged builds.

## 0.1.1

### Patch Changes

- f2effde: Check GitHub Releases for updates and prompt to install.
- 0105e03: Automate versioning and release tagging with changesets.
