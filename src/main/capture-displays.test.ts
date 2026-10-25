import { it, expect, vi } from 'vitest'
vi.mock('electron',()=>({nativeImage:{},screen:{}}))
import { desktopLayout } from './capture-displays'
it('maps mixed-DPI monitors and negative origins onto one bounded DIP canvas',()=>{
  const layout=desktopLayout([{bounds:{x:-1280,y:100,width:1280,height:720},scaleFactor:1.5},{bounds:{x:0,y:0,width:2560,height:1440},scaleFactor:1}])
  expect(layout.bounds).toEqual({x:-1280,y:0,width:3840,height:1440})
  expect(layout.scale).toBe(1.5)
  const large=desktopLayout([{bounds:{x:-7680,y:0,width:7680,height:4320},scaleFactor:2},{bounds:{x:0,y:0,width:7680,height:4320},scaleFactor:1}])
  expect(large.bounds.width*large.scale).toBeLessThanOrEqual(8192)
  expect(large.bounds.width*large.bounds.height*large.scale**2).toBeLessThanOrEqual(32_000_000)
})
