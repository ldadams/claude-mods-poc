// Small string and time helpers with no I/O.

export function slugify(title) {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'feature'
}

export function splitFirst(args) {
  const trimmed = (args || '').trim()
  if (!trimmed) return ['', '']
  const idx = trimmed.search(/\s/)
  if (idx === -1) return [trimmed, '']
  return [trimmed.slice(0, idx), trimmed.slice(idx + 1).trim()]
}

export function truncate(text, max) {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '\n…(truncated)' : text
}

export function errText(err) {
  return err && err.message ? err.message : String(err)
}

export function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}

export function elapsed(iso) {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!(ms >= 0)) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}

export function firstLine(text) {
  return (text || '').trim().split('\n')[0] || ''
}
