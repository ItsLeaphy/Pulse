import { LocalStorageAdapter } from './storage'
import { renderApp } from './ui'

const storage = new LocalStorageAdapter()
renderApp(storage)
