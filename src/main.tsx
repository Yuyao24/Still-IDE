import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// The window itself never scrolls: if focus or scrollIntoView nudges the page sideways (or
// down), put it straight back, so the whole interface doesn't drift.
const page = () => document.scrollingElement ?? document.documentElement
const settle = () => { const element = page(); if (element.scrollLeft || element.scrollTop) { element.scrollLeft = 0; element.scrollTop = 0 } }
window.addEventListener('scroll', settle, { passive: true })
document.getElementById('root')?.addEventListener('scroll', event => { const root = event.currentTarget as HTMLElement; root.scrollLeft = 0; root.scrollTop = 0 }, { passive: true })

createRoot(document.getElementById('root')!).render(<App />)
