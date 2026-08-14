/**
 * adapters/deepseek-harness/http-body.mjs — 读取 HTTP 请求体（JSON）
 */
export function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`request body too large (>${maxBytes} bytes)`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e?.message ?? e}`))
      }
    })
    req.on('error', reject)
  })
}
