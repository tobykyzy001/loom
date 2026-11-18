import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import { startOfflineShell } from './lib/offline-shell'

createApp(App).mount('#app')
startOfflineShell()
