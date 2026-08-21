# @dbchat/desktop

## 0.4.0

### Minor Changes

- d706ce8: Replace the sidebar "Check for updates" button with a single status icon. Hover shows the version diff and release notes; click downloads the update, then the icon switches to "restart to install". Background update checks no longer pop a dialog — they just light up the icon.

## 0.3.0

### Patch Changes

- 1501902: Reduce idle memory: lazy-load the SQL editor (CodeMirror) and chat markdown renderer, load `node-sql-parser` on first use in the server (idle RSS ~108 MB → ~56 MB), and cap the renderer V8 heap.

## 0.2.0

### Patch Changes

- a9d3912: Load saved connection URLs and passwords into the edit form, mask them by default with controls to reveal them, and convert between URLs and individual fields when switching tabs.

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
