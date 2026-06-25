# Security

## Threat model

inter-claude-channels delivers messages from peer sessions straight into
Claude's context as `<channel>` events. **Any text a peer sends is untrusted
input and a prompt-injection surface.** The project limits exposure by design:

- The bus is a directory under your home (`~/.claude/channels/inter-claude`).
- It binds **no network port** — peers are other local sessions run by the same
  user on the same machine.
- Peers are discovered from the local presence directory, not the network.

The trust boundary is therefore **one machine, one user**. Treat any session
you connect as able to put text in front of every other connected session.

## Recommendations

- Don't point `INTER_CLAUDE_HOME` at a shared, networked, or world-writable
  directory.
- Be deliberate about combining channels with `--dangerously-skip-permissions`:
  a peer message could then trigger tool use without a prompt.
- Channels are a Claude Code research-preview feature and require
  `--dangerously-load-development-channels` to load this server. Only do so for
  code you trust.

## Reporting a vulnerability

Please do not open a public issue for security problems. Email the maintainer at
**patrabiswajit133@gmail.com** with details and steps to reproduce. You'll get
an acknowledgement within a few days.
