// Session states in words, glyphs and theme colors, and one-line summaries of what waits on the user.

import { firstLine } from './util.js'

export const STATUS = {
  idle: { word: 'not started', glyph: '○', color: 'inactive' },
  running: { word: 'working', glyph: '●', color: 'claude' },
  'needs-you': { word: 'needs you', glyph: '?', color: 'permission' },
  ready: { word: 'your turn', glyph: '✓', color: 'success' },
  paused: { word: 'paused', glyph: '‖', color: 'subtle' },
  error: { word: 'error', glyph: '✗', color: 'error' },
}

export const statusOf = (a) => STATUS[(a && a.status) || 'idle'] || STATUS.idle

export function statusWord(a) {
  return statusOf(a).word
}

export function statusGlyph(a) {
  return statusOf(a).glyph
}

// Theme keys, so the pane follows the person's light or dark theme.
export function statusColor(a) {
  return statusOf(a).color
}

// Working or waiting on you: the session is mid-turn.
export const isBusy = (a) => !!a && (a.status === 'running' || a.status === 'needs-you')

// Has a conversation (live or resumable), so "start" no longer applies.
export const hasSession = (a) => !!a && (!!a.sessionId || !!a.live)

// One line on what a tool call is about: its command, file, URL or pattern.
export function toolBrief(input) {
  const i = input || {}
  return firstLine(String(i.command || i.file_path || i.path || i.url || i.pattern || i.description || i.prompt || ''))
}

// What a waiting request asks, in one line.
export function pendingSummary(p) {
  if (!p) return ''
  if (p.kind === 'question') {
    const q = ((p.input && p.input.questions) || [])[0]
    return firstLine((q && q.question) || 'a question')
  }
  if (p.toolName === 'ExitPlanMode') return 'has a plan for you to approve'
  const brief = toolBrief(p.input)
  return 'wants to use ' + p.toolName + (brief ? ': ' + brief : '')
}
