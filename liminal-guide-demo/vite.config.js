import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'

// 아카이브 데이터 실시간 저장을 위한 Vite 플러그인
function archivePersistPlugin() {
  return {
    name: 'archive-persist',
    configureServer(server) {
      // POST /api/archive - 새로운 아카이브 항목 추가
      server.middlewares.use('/api/archive', (req, res, next) => {
        if (req.method !== 'POST') return next()

        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const newEntry = JSON.parse(body)
            const filePath = path.resolve(__dirname, 'src/data/archiveSeed.json')
            const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            existing.push(newEntry)
            fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, count: existing.length }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        })
      })

      // GET /api/archive - 전체 아카이브 데이터 조회
      server.middlewares.use('/api/archive', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const filePath = path.resolve(__dirname, 'src/data/archiveSeed.json')
          const data = fs.readFileSync(filePath, 'utf-8')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(data)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    archivePersistPlugin(),
  ],
  base: '/miginalia/',
})