# FortiGate Live Config (VS Code)

Browse and edit a live FortiGate's configuration straight from VS Code.
The extension connects over SSH, fetches the running configuration, and
renders it as a browsable tree in the activity bar. Clicking an entry
opens it as a virtual text file you edit like any other code. Saving
(Ctrl+S / Cmd+S) *stages* your change. The **Apply Changes** button in
the view title generates a minimal CLI script, runs it on the device,
reads the affected sections back, and only reports success once the live
device matches what you edited.

## Features

- Activity-bar tree grouped by top-level `config` path (`system`, `firewall`, `router`, ...)
- Singleton and table blocks are both supported: tables expand into per-entry files
- Virtual file system (`fortigate://` scheme) so Ctrl+S just works
- Staged changes with a running count in the status bar and a tree badge on modified nodes
- Fine-grained CLI diff: only changed `set` / `unset` / `edit` / `delete` lines are sent
- Read-back verification: after apply, each touched section is `show`-n, re-parsed,
  and structurally compared to your expected state. Mismatches are surfaced verbatim.
- Multiple named connection profiles stored in `settings.json`; credentials
  (passwords, private keys, passphrases) are kept in VS Code's `SecretStorage`.
- Password and SSH-key authentication, with optional pinned host key fingerprint.

## Requirements

- VS Code 1.90 or later.
- Node.js 18+ and npm, for building from source.
- SSH access to a FortiGate running FortiOS 6.x or newer. The CLI user
  needs at least `super_admin-readonly` for browsing and `super_admin` to
  apply changes.

## Getting started

### Build and run

```bash
npm install
npm run build
```

Then in VS Code press **F5** (Run Extension) to launch an Extension
Development Host with this extension loaded.

### Add a profile

1. Command Palette -> **FortiGate: Add Profile**
2. Fill in host, port (22), username, and choose Password or SSH key auth.
3. Credentials are stored in SecretStorage, not in settings.

Alternatively add entries manually in `settings.json`:

```json
"fortigate.profiles": [
  {
    "id": "lab",
    "name": "Lab FortiGate",
    "host": "10.0.0.1",
    "port": 22,
    "username": "admin",
    "authMethod": "password"
  }
]
```

Then run **FortiGate: Edit Profile** -> *Update password* to save the secret.

### Connect and edit

1. Open the FortiGate activity-bar view.
2. Click the plug icon (or run **FortiGate: Connect**) and pick a profile.
3. Browse the tree. Click a leaf (`firewall policy/1`, `system global`, ...)
   to open it as a virtual file.
4. Edit normally. Save with **Ctrl+S** to stage.
5. Click **Show Pending Changes** to preview the CLI script that will run.
6. Click **Apply Changes** to execute. The extension reads the modified
   sections back and only reports success if they match your edits.

### Edit whole sections or groups at once

Clicking a tabular row (e.g. `firewall policy`) expands it to show each
entry. If you'd rather edit all entries together in one buffer, **right
click the row** and choose **Open Whole Section** - this opens a virtual
file containing the entire `config firewall policy ... end` block with
every `edit` entry inside. Save the buffer to stage every change in it
at once (adds, edits, deletes of entries are all detected by the diff).

For even broader edits, **right click a group row** (e.g. the top-level
`system` node) and choose **Open All Sections In Group** - this
concatenates every `config system ... end` block (global, interface, dns,
dhcp server, ...) into a single editable buffer. Each block is still
staged independently when you save.

## How it works

```
ssh show  ->  AST (pristine)
                |
                v
    tree view + virtual file system
                |
      editor save (Ctrl+S)
                |
                v
    staged-overlay AST
                |
            apply:
    pristine vs staged -> minimal CLI script
                |
                v
    runScript over SSH (per top-level config path)
                |
                v
    show each touched path -> parse -> compare with expected
                |
      all match -> success, refresh pristine, clear staging
      mismatch  -> error, staging kept so you can retry
```

Key design decisions:

- **Fine-grained diff** over section-replace. Only the `set` / `unset` /
  `edit` / `delete` lines that actually change are sent, which minimises
  the blast radius of a misclick and preserves settings you didn't touch.
- **Single-VDOM** scope for now; the tree/URI layout is designed so VDOM
  support can be added later by prefixing the URI with a `vdom/<name>/` segment.
- **Paging disabled at session start** (`config system console` /
  `set output standard`) so `show` returns the whole config in one buffer.
- **Prompt detection** is regex-based (`<hostname>[ (vdom)] #` at buffer end),
  overridable via `fortigate.readyPromptRegex` in settings.
- **Session keepalive & auto-reconnect**: a trivial `get system status` is sent
  every ~3 minutes so FortiGate's default 5-minute `admintimeout` does not kill
  the CLI shell. If the session is dropped anyway (network blip, manual
  `execute ssh-session close-all`, etc.), the next Refresh / Apply / open
  transparently re-opens the SSH connection before running the command. Read
  operations (Refresh) are retried once if they fail mid-flight; Apply is not
  retried to avoid re-executing commands that may already have committed on the
  device.

## Extension settings

| Key | Purpose |
|-----|---------|
| `fortigate.profiles` | Array of connection profiles. |
| `fortigate.readyPromptRegex` | Regex used to detect the device prompt. |
| `fortigate.commandTimeoutMs` | Per-command timeout (ms). Default 30000. |

## Commands

| Command | What it does |
|---------|--------------|
| FortiGate: Add / Edit / Remove Profile | Manage profiles and their secrets. |
| FortiGate: Connect / Disconnect | Open or close the SSH session. |
| FortiGate: Refresh Configuration | Re-run `show` and rebuild the tree. |
| FortiGate: Show Pending Changes | Preview the CLI script in a read-only editor. |
| FortiGate: Apply Changes | Run the script, verify the read-back, commit or surface mismatches. |
| FortiGate: Discard Staged Changes | Drop all staging without touching the device. |

## Scripts

```bash
npm run build    # production bundle to dist/extension.js
npm run watch    # esbuild watch mode
npm run unit     # parser + diff unit tests
npm run lint     # eslint
```

## Limitations and out-of-scope

- Multi-VDOM devices: browsing/editing is scoped to the current VDOM as
  seen by the SSH user (typically `root`). Explicit VDOM navigation is
  not yet implemented.
- 2FA / keyboard-interactive authentication (e.g. FortiToken) is not
  currently supported.
- Nested `config` blocks are included inside an entry's virtual file and
  re-written together with the entry; they cannot be edited in isolation yet.
- There is no offline "draft" mode; editing requires a live SSH session.

## Safety notes

- **Always review** the preview produced by *Show Pending Changes*.
- Apply is transactional per top-level path. If one path fails, earlier
  paths have already been committed on the device.
- Read-back verification runs after the apply completes. A mismatch does
  not automatically roll back (FortiGate CLI has no generic rollback); it
  is surfaced so you can remediate manually.

## License

MIT
