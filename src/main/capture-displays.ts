import { nativeImage, screen, type Display, type NativeImage } from 'electron'
import type { CaptureRect } from '@shared/screenshot'
import { captureScreen } from './capture-screen'

/** A common DIP canvas avoids stretching one display's scale over a mixed-DPI desktop. */
export function desktopLayout(displays:readonly Pick<Display,'bounds'|'scaleFactor'>[]):{bounds:CaptureRect;scale:number} {
  const x=Math.min(...displays.map(d=>d.bounds.x)),y=Math.min(...displays.map(d=>d.bounds.y))
  const width=Math.max(...displays.map(d=>d.bounds.x+d.bounds.width))-x,height=Math.max(...displays.map(d=>d.bounds.y+d.bounds.height))-y
  const scale=Math.min(Math.max(...displays.map(d=>d.scaleFactor)),8192/Math.max(width,height),Math.sqrt(32_000_000/(width*height)))
  return {bounds:{x,y,width,height},scale}
}
export function captureDisplays(displays:Display[]):{image:NativeImage;bounds:CaptureRect} {
  const {bounds,scale}=desktopLayout(displays),width=Math.max(1,Math.floor(bounds.width*scale)),height=Math.max(1,Math.floor(bounds.height*scale))
  const pixels=Buffer.alloc(width*height*4)
  for(const display of displays){
    const x=Math.round((display.bounds.x-bounds.x)*scale),y=Math.round((display.bounds.y-bounds.y)*scale)
    const w=Math.min(width-x,Math.round(display.bounds.width*scale)),h=Math.min(height-y,Math.round(display.bounds.height*scale))
    const image=captureScreen(screen.dipToScreenRect(null,display.bounds)).resize({width:w,height:h,quality:'best'}).toBitmap()
    for(let row=0;row<h;row++)image.copy(pixels,((y+row)*width+x)*4,row*w*4,(row+1)*w*4)
  }
  return {image:nativeImage.createFromBitmap(pixels,{width,height}),bounds}
}
