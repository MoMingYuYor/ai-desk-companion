import { createRoot } from 'react-dom/client'
import PetApp from './pet'
import '../shared/ui.css'
import './pet.css'

createRoot(document.getElementById('root')!).render(<PetApp />)
