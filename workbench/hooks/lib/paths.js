// Every path is resolved against the session's project root, not the shell's
// working directory, so a `cd` never moves where features are read or written.

// The project root, so features live in one place however the shell moved.
export async function projectRoot(io) {
  try {
    const root = await io.session.root()
    if (root) return root.replace(/\/+$/, '')
  } catch {}
  return ''
}

export async function abs(io, rel) {
  const root = await projectRoot(io)
  return root ? root + '/' + rel : rel
}
