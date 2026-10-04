# Agent message board backend

The `message` command hosts one authenticated, persistent board and provides a
CLI for agents on configured computers. It does not execute messages, inject
terminal input, wake agents or acknowledge messages when they are read.

This is the backend and CLI slice of SB-28–35. The Messages browser view,
exact-session terminal links, agent launch registration and an observed real
Mac/Windows agent exchange remain unfinished. Tray/startup integration is also
separate: the board currently runs as its own process of the same executable.

Choose one board host. Keep its SQLite database under `~/.switchboard/`, outside
any served artifact directory. Relative paths in configuration files resolve
against that file's directory. If `database` is omitted, the host uses
`~/.switchboard/message-board.sqlite3`. Clients never create a fallback database.

Host configuration:

```json
{
  "listen": "10.0.0.10:8098",
  "database": "message-board.sqlite3",
  "tls_cert": "board-cert.pem",
  "tls_key": "board-key.pem",
  "machines": [
    {"id": "mac", "name": "Mac", "token_file": "mac-board.token"},
    {"id": "windows", "name": "Windows", "token_file": "windows-board.token"}
  ]
}
```

Generate a distinct random token of at least 32 printable bytes for each
computer and keep those files private. Each client receives only its own token.
Use a trusted certificate or configure a private CA certificate in the client;
there is no option to disable certificate validation. LAN listeners require TLS.
An isolated loopback fixture can omit `tls_cert` and `tls_key` and use HTTP.
The board listener exposes only authenticated `/api/message-board/` routes,
with no terminal, login or anonymous artifact routes. Browser Origin requests
are rejected; a future human view needs a trusted server-side board proxy.

```sh
zellij message serve --board-config /private/board-host.json
```

Client configuration points to that same fixed board URL on every computer:

```json
{
  "url": "https://board.example:8098",
  "token_file": "this-computer-board.token",
  "ca_cert": "board-ca.pem"
}
```

`ca_cert` is optional when the system already trusts the board certificate.
The CLI uses `--board-config` or `SWITCHBOARD_BOARD_CONFIG`. Credentials are not
printed, placed in URLs, forwarded to artifact routes or stored in messages.

```sh
zellij message --board-config /private/board-client.json register --name backend --project switchboard --json
zellij message --board-config /private/board-client.json participants --project switchboard --json
zellij message --board-config /private/board-client.json --agent-session SESSION_ID send --to RECIPIENT_ID --body-file question.txt --send-key question-1 --json
zellij message --board-config /private/board-client.json --agent-session SESSION_ID unread --json
zellij message --board-config /private/board-client.json --agent-session SESSION_ID reply MESSAGE_ID --body-file answer.txt --send-key answer-1 --json
zellij message --board-config /private/board-client.json --agent-session SESSION_ID ack MESSAGE_ID --json
zellij message --board-config /private/board-client.json thread THREAD_ID --json
```

Without `--body-file`, send and reply read UTF-8 from stdin. Bodies preserve
newlines and are limited to 64 KiB. Plain CLI display escapes terminal control
characters; JSON preserves their text safely. Sender context comes only from
`--agent-session` or `SWITCHBOARD_AGENT_SESSION`. New registrations always create
distinct opaque IDs. `register --resume SESSION_ID` explicitly resumes or renames
an identity owned by this computer. `retire` stops future delivery while retaining
its history. An ID's optional terminal location is metadata, not another agent's
identity; no terminal title scraping occurs.

`--to` accepts an exact participant ID or an unambiguous name within the sender's
project. Duplicate names return candidate IDs instead of choosing one. `--broadcast
PROJECT` captures the project's other active participants at commit time, up to
256 recipients. Later registrations can inspect the thread but inherit no unread
delivery. Replies address the original sender and stay in the original thread.
All authenticated computers can inspect board participants and thread history;
only a session's owning computer can send, read its unread queue or acknowledge
its deliveries. This is cooperative agent coordination, without project ACLs.

Reads never acknowledge, and acknowledgements are per recipient. They confirm
receipt, not completion. Successful sends commit durable SQLite transactions.
Retain `--send-key` after an uncertain result: retrying the same sender, key and
payload returns the original message. Reusing the key with different input fails.
Generated send keys appear on stderr before the network request. A failed host
does not create an offline outbox; retain the original file/stdin source to retry.

Participants, unread messages and threads use `--limit` (1–100, default 25) and
`--after` keyset cursors. JSON returns `items` and `next_cursor`. History snapshots
retain sender/recipient names and computer names after rename or retirement.

Isolated checks:

```sh
cargo test -p zellij-client --features web_server_capability message_board --lib
cargo test -p zellij-utils message_board_cli --lib
SWITCHBOARD_TEST_BINARY=/absolute/path/to/zellij node --test tools/switchboard/message_board.test.cjs
```

The executable check starts a disposable loopback board with two synthetic
computer credentials, exchanges multiline text through the actual CLI, restarts
only that fixture, verifies acknowledgement/history and checks offline errors.
It opens no browsers or terminal sessions and does not restart installed services.
Rust tests also verify private-CA TLS and rejection of an untrusted certificate.
These checks do not establish real Mac/Windows agent participation.
