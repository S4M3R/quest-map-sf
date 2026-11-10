// Tiny toast helper (lead). Use for non-fatal errors: missing keys, geocode misses, mic denied.
let timer: number | undefined

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 3500): void {
  const el = document.getElementById('toast')
  if (!el) return
  el.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'panel'
  box.style.cssText = `padding:10px 14px;font-size:14px;color:${kind === 'error' ? 'var(--danger)' : 'var(--text)'}`
  box.textContent = message
  el.appendChild(box)
  window.clearTimeout(timer)
  timer = window.setTimeout(() => (el.innerHTML = ''), ms)
}
