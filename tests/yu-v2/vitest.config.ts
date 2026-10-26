import {defineConfig} from 'vitest/config'
import {resolve} from 'node:path'
export default defineConfig({resolve:{alias:{'@shared':resolve('src/shared')}},test:{environment:'node',include:process.env.YU_V2_REPLAY_SCHEDULER==='1'?['tests/yu-v2/scheduler-verification.test.ts']:['tests/yu-v2/run.test.ts','tests/yu-v2/diagnostic.test.ts'],maxWorkers:1,testTimeout:120000,hookTimeout:45000,fileParallelism:false}})
