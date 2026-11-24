import { createRoot } from 'react-dom/client'
import App from './App'
import { installBounce } from './bounce'
import './styles.css'

installBounce()
createRoot(document.getElementById('root')!).render(<App />)
