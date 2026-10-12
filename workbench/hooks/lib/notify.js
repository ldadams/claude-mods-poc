// macOS Notification Center: in-session agents' questions and finishes, and
// /feature notify test. Workbench Web posts its own for its sessions.

import { truncate } from './util.js'

// A system notification (macOS Notification Center). Workbench Web posts its own
// for agents; this is for /feature notify test. Text goes in as argv, never
// spliced into the script.
export async function osNotify(io, title, text) {
  try {
    await io.process.run([
      'osascript',
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
      '-e', 'end run',
      title,
      truncate(text, 200),
    ])
  } catch {
    // No osascript (not macOS) or notifications blocked.
  }
}
