// Development-only conversion. Originals are retained in logo/; no runtime dependency.
import { execFileSync } from 'node:child_process'
execFileSync(process.env.YU_PYTHON || 'python', ['scripts/make-icon.py'], { stdio: 'inherit', windowsHide: true })
