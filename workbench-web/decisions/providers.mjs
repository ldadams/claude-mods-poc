// System One providers: something that answers typed questions about a state in one
// call (Jev's `system_one` request and response shape). Laya runs in this process;
// "http" is any server speaking POST /v1/systemone (a Laya server, or TypeSafe's Jev).

// A provider has systemOne(state, questions), status() and warm(). A call that takes
// longer than timeoutMs rejects, so a slow model never holds up an agent: the caller
// treats it as "no judgment" and asks the user as before.
export function createProvider(config) {
  if (config.provider === 'laya') return layaProvider(config)
  if (config.provider === 'http') return httpProvider(config)
  return offProvider()
}

function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(what + ' took longer than ' + ms + ' ms')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function offProvider() {
  return {
    name: 'off',
    status: () => ({ ready: false, loading: false, error: '' }),
    warm: () => {},
    systemOne: async () => {
      throw new Error('decisions are off')
    },
  }
}

// Laya in this process (@receptron/laya over ONNX Runtime). The first load downloads
// about 1.7 GB of weights to ~/.cache/receptron-laya and takes a while, so it starts in
// the background (warm) and calls before it is ready time out instead of waiting.
function layaProvider(config) {
  let model = null
  let loading = null
  let error = ''
  const load = () => {
    if (!loading) {
      loading = import('@receptron/laya')
        .then(({ Laya }) => Laya.load(config.modelDir ? { modelDir: config.modelDir } : {}))
        .then((m) => {
          model = m
          error = ''
          return m
        })
        .catch((err) => {
          error = String(err.message || err)
          loading = null // let a later call try again
          throw err
        })
    }
    return loading
  }
  return {
    name: 'laya',
    status: () => ({ ready: !!model, loading: !!loading && !model, error }),
    warm: () => load().catch(() => {}),
    systemOne: async (state, questions) => {
      const m = model || (await withTimeout(load(), config.timeoutMs, 'loading Laya'))
      return withTimeout(m.systemOne(state, questions), config.timeoutMs, 'Laya')
    },
  }
}

// Any server with POST /v1/systemone: `laya serve`, or Jev at https://api.typesafe.ai
// with a key from the environment variable named by keyEnv (never from a file).
function httpProvider(config) {
  let error = ''
  return {
    name: 'http',
    status: () => ({ ready: !!config.url, loading: false, error }),
    warm: () => {},
    systemOne: async (state, questions) => {
      if (!config.url) throw new Error('decisions.url is not set')
      const headers = { 'Content-Type': 'application/json' }
      const key = config.keyEnv ? process.env[config.keyEnv] : ''
      if (key) headers.Authorization = 'Bearer ' + key
      const body = JSON.stringify({ ...(config.model ? { model: config.model } : {}), state, questions })
      const res = await fetch(config.url.replace(/\/+$/, '') + '/v1/systemone', {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      if (!res.ok) {
        error = 'HTTP ' + res.status
        throw new Error('System One server answered ' + res.status)
      }
      error = ''
      return res.json()
    },
  }
}
