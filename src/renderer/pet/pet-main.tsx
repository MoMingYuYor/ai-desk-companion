import { createRoot } from 'react-dom/client'
import PetApp from './pet'
import '../shared/ui.css'

createRoot(document.getElementById('root')!).render(<PetApp />)
