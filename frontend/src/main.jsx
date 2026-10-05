import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/responsive.css'
import './styles/dose.css'
import { IconSprite } from './Icon'
import App from './App'

createRoot(document.getElementById('root')).render(<><IconSprite /><App /></>)
